#!/usr/bin/env node
// 对比 Monquery 接口在"节点级平均值"与"逐卡明细"两种查询粒度下的真实网络耗时。
// 用法: node web/scripts/benchmark-monquery-granularity.mjs [重复次数]
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
const CARD_COUNT = clusterScope.cardsPerNode;
const MONQUERY_NODE_BATCH_SIZE = 16;
const CST_OFFSET_SECONDS = 8 * 60 * 60;

const REPEAT = Number(process.argv[2] || 5);

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

async function fetchWindow(items, startAt, endAt, intervalSeconds) {
  const batches = [];
  for (let index = 0; index < MONITORED_NODES.length; index += MONQUERY_NODE_BATCH_SIZE) {
    batches.push(MONITORED_NODES.slice(index, index + MONQUERY_NODE_BATCH_SIZE));
  }
  const startedAt = performance.now();
  await Promise.all(batches.map(batch => {
    const params = new URLSearchParams({
      namespaces: batch.map(namespace).join(','),
      items: items.join(','),
      start: formatMonqueryDateTime(startAt),
      end: formatMonqueryDateTime(endAt),
      interval: String(intervalSeconds),
    });
    return requestJson(config.backend.monquery.host, config.backend.monquery.port, `/monquery/getHistoryitemdata?${params}`);
  }));
  return performance.now() - startedAt;
}

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const avg = sum / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`\n${label}`);
  console.log(`  次数: ${sorted.length}  平均: ${formatMs(avg)}  中位: ${formatMs(median)}  最小: ${formatMs(min)}  最大: ${formatMs(max)}`);
  console.log(`  明细: ${sorted.map(formatMs).join(', ')}`);
  return { avg, median, min, max };
}

async function main() {
  const endAt = Math.floor(Date.now() / 1000);
  const startAt = endAt - 3600; // 最近1小时，与聚合计算基准测试保持相近量级
  const intervalSeconds = 300;

  const NODE_LEVEL_ITEMS = ['XPU_AVERAGE_UTILIZATION'];
  const PER_CARD_ITEMS = Array.from({ length: CARD_COUNT }, (_, card) => `XPU${card}_MEM_UTILIZATION`);

  console.log(`测试范围: ${MONITORED_NODES.length} 个节点，最近1小时，间隔 ${intervalSeconds}s`);
  console.log(`节点级查询字段数: ${NODE_LEVEL_ITEMS.length}（${NODE_LEVEL_ITEMS.join(',')}）`);
  console.log(`逐卡查询字段数: ${PER_CARD_ITEMS.length}（${PER_CARD_ITEMS[0]} ... ${PER_CARD_ITEMS[PER_CARD_ITEMS.length - 1]}）`);

  const nodeLevelSamples = [];
  const perCardSamples = [];

  for (let round = 0; round < REPEAT; round += 1) {
    nodeLevelSamples.push(await fetchWindow(NODE_LEVEL_ITEMS, startAt, endAt, intervalSeconds));
    perCardSamples.push(await fetchWindow(PER_CARD_ITEMS, startAt, endAt, intervalSeconds));
  }

  const nodeStats = summarize('节点级查询（仅 XPU_AVERAGE_UTILIZATION）', nodeLevelSamples);
  const cardStats = summarize(`逐卡查询（${CARD_COUNT} 个 XPU{n}_MEM_UTILIZATION 字段）`, perCardSamples);

  console.log(`\n对比: 逐卡查询平均耗时是节点级查询的 ${(cardStats.avg / nodeStats.avg).toFixed(2)} 倍`);
}

main().catch(error => {
  console.error('基准测试失败:', error.message);
  process.exitCode = 1;
});
