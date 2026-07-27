#!/usr/bin/env node
// 对比 /app 页面实际使用的两种数据获取策略的真实耗时：
// 1) fetchMonqueryNodeUtilization：全部节点分批(每批24)，并行，仅查节点级 XPU_AVERAGE_UTILIZATION
// 2) fetchMonqueryCardUtilizationBatches：全部节点分批(每批8)，并行发起+逐批到达，查16个卡级字段(8 XPU + 8 显存)
// 用法: node web/scripts/benchmark-app-fetch-strategy.mjs [重复次数]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const clusterScope = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'shared', 'cluster-scope.json'), 'utf8'),
);

const CLUSTER_BACKUP = 'wxtky02-p800-backup-8nic-vd';
const CLUSTER_NON_BACKUP = 'wxtky02-p800-8nic-vd';
const NON_BACKUP_NODES = new Set([32, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
const MONITORED_NODES = clusterScope.nodeIds;
const CARDS_PER_NODE = clusterScope.cardsPerNode;
const CST_OFFSET_SECONDS = 8 * 60 * 60;

const REPEAT = Number(process.argv[2] || 5);

// 与 web/src/services/api.js 保持一致的字段与批次大小
const MONQUERY_NODE_ITEMS = ['XPU_AVERAGE_UTILIZATION'];
const MONQUERY_CARD_XPU_ITEMS = Array.from({ length: CARDS_PER_NODE }, (_, c) => `XPU${c}_XPU_UTILIZATION`);
const MONQUERY_CARD_MEM_ITEMS = Array.from({ length: CARDS_PER_NODE }, (_, c) => `XPU${c}_MEM_UTILIZATION`);
const MONQUERY_CARD_ITEMS = [...MONQUERY_CARD_XPU_ITEMS, ...MONQUERY_CARD_MEM_ITEMS];
const NODE_BATCH_SIZE = 24;
const CARD_BATCH_SIZE = 8;

function namespace(node) {
  const cluster = NON_BACKUP_NODES.has(node) ? CLUSTER_NON_BACKUP : CLUSTER_BACKUP;
  return `${cluster}-node${node}.wxtky02`;
}

function formatMonqueryDateTime(timestamp) {
  const date = new Date((timestamp + CST_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function requestJson(host, port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: requestPath, timeout: 90_000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Upstream returned ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Upstream returned invalid JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Upstream request timed out after 90 seconds')));
    request.on('error', reject);
  });
}

function makeNodeBatches(batchSize) {
  const batches = [];
  for (let index = 0; index < MONITORED_NODES.length; index += batchSize) {
    batches.push(MONITORED_NODES.slice(index, index + batchSize));
  }
  return batches;
}

async function fetchItemsForBatch(nodeNums, items, startAt, endAt) {
  const params = new URLSearchParams({
    namespaces: nodeNums.map(namespace).join(','),
    items: items.join(','),
    start: formatMonqueryDateTime(startAt),
    end: formatMonqueryDateTime(endAt),
    interval: '300',
  });
  return requestJson(config.backend.monquery.host, config.backend.monquery.port, `/monquery/getHistoryitemdata?${params}`);
}

// 策略1：对齐 fetchMonqueryNodeUtilization —— 全部节点分批(每批24)，Promise.all 并行
async function benchmarkNodeUtilization(startAt, endAt) {
  const startedAt = performance.now();
  await Promise.all(
    makeNodeBatches(NODE_BATCH_SIZE).map(nodeNums => fetchItemsForBatch(nodeNums, MONQUERY_NODE_ITEMS, startAt, endAt))
  );
  return performance.now() - startedAt;
}

// 策略2：对齐 fetchMonqueryCardUtilizationBatches —— 全部节点分批(每批8)，并行发起，Promise.race 逐批消费
// 首屏关心的是“全部批次到达”耗时（等价于 Promise.all，因为所有请求仍是同时发出的）
async function benchmarkCardUtilizationBatches(startAt, endAt) {
  const startedAt = performance.now();
  const pending = makeNodeBatches(CARD_BATCH_SIZE).map(nodeNums =>
    fetchItemsForBatch(nodeNums, MONQUERY_CARD_ITEMS, startAt, endAt)
  );
  let firstBatchMs = null;
  await Promise.all(pending.map(async promise => {
    await promise;
    if (firstBatchMs === null) firstBatchMs = performance.now() - startedAt;
  }));
  return { totalMs: performance.now() - startedAt, firstBatchMs };
}

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const avg = sum / sorted.length;
  console.log(`\n${label}`);
  console.log(`  次数: ${sorted.length}  平均: ${formatMs(avg)}  中位: ${formatMs(sorted[Math.floor(sorted.length / 2)])}  最小: ${formatMs(sorted[0])}  最大: ${formatMs(sorted[sorted.length - 1])}`);
  console.log(`  明细: ${sorted.map(formatMs).join(', ')}`);
  return { avg };
}

async function main() {
  const endAt = Math.floor(Date.now() / 1000);
  const startAt = endAt - 3600;

  console.log(`测试范围: ${MONITORED_NODES.length} 个节点，最近1小时，interval=300s`);
  console.log(`策略1 - fetchMonqueryNodeUtilization 对齐: ${Math.ceil(MONITORED_NODES.length / NODE_BATCH_SIZE)} 批（每批${NODE_BATCH_SIZE}节点），字段: ${MONQUERY_NODE_ITEMS.join(',')}`);
  console.log(`策略2 - fetchMonqueryCardUtilizationBatches 对齐: ${Math.ceil(MONITORED_NODES.length / CARD_BATCH_SIZE)} 批（每批${CARD_BATCH_SIZE}节点），字段数: ${MONQUERY_CARD_ITEMS.length}（8卡XPU+8卡显存）`);

  const nodeSamples = [];
  const cardTotalSamples = [];
  const cardFirstBatchSamples = [];

  for (let round = 0; round < REPEAT; round += 1) {
    nodeSamples.push(await benchmarkNodeUtilization(startAt, endAt));
    const cardResult = await benchmarkCardUtilizationBatches(startAt, endAt);
    cardTotalSamples.push(cardResult.totalMs);
    cardFirstBatchSamples.push(cardResult.firstBatchMs);
  }

  const nodeStats = summarize('策略1: 节点级并行查询（首屏用，仅XPU均值）', nodeSamples);
  summarize('策略2: 卡级并行查询 - 首批到达耗时（渐进渲染起点）', cardFirstBatchSamples);
  const cardStats = summarize('策略2: 卡级并行查询 - 全部6批到达耗时（完整卡级数据就位）', cardTotalSamples);

  console.log(`\n对比: 卡级全量完成耗时是节点级查询的 ${(cardStats.avg / nodeStats.avg).toFixed(2)} 倍`);
  console.log(`说明: 页面首屏只依赖策略1（节点级），策略2在后台异步渐进加载卡级明细，不阻塞首屏`);
}

main().catch(error => {
  console.error('基准测试失败:', error.message);
  process.exitCode = 1;
});
