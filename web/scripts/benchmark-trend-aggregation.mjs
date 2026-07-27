// 基准测试：对比"节点级值算术平均"与"卡级值算术平均"两种聚合粒度的耗时差异。
// 复刻 web/server/trend-service.cjs 中 parseSamples（第138-160行）的 sum/count 聚合模式：
// - XPU 利用率：对每个采样点的节点级值（最多 NODE_COUNT 个）求和再除以命中节点数
// - 显存利用率：对每个采样点的单卡值（最多 TOTAL_CARDS 个）求和再除以命中卡数
// 运行：cd web && node scripts/benchmark-trend-aggregation.mjs

import clusterScope from '../shared/cluster-scope.json' with { type: 'json' };

const NODE_COUNT = clusterScope.nodeIds.length;
const CARD_COUNT = clusterScope.cardsPerNode;
const TOTAL_CARDS = NODE_COUNT * CARD_COUNT;
const SAMPLE_INTERVAL_SECONDS = 300;

const SCALES = [
  { label: '1 天', points: Math.round((24 * 60 * 60) / SAMPLE_INTERVAL_SECONDS) },
  { label: '1 个月', points: Math.round((30 * 24 * 60 * 60) / SAMPLE_INTERVAL_SECONDS) },
  { label: '6 个月', points: Math.round((180 * 24 * 60 * 60) / SAMPLE_INTERVAL_SECONDS) },
];

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 10;

// 固定种子的简单 PRNG（mulberry32），保证多次运行的数据可复现、可比较。
function createRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSamples(points, columns, rng) {
  return Array.from({ length: points }, () => Array.from({ length: columns }, () => rng() * 100));
}

// 镜 parseSamples 138-160 行的 xpu 分支：节点级值直接求平均。
function averageNodeLevel(nodeValues) {
  let sum = 0;
  let count = 0;
  for (const value of nodeValues) {
    sum += value;
    count += 1;
  }
  return count ? sum / count : null;
}

// 镜 parseSamples 138-160 行的 memory 分支：单卡值直接求平均。
function averageCardLevel(cardValues) {
  let sum = 0;
  let count = 0;
  for (const value of cardValues) {
    sum += value;
    count += 1;
  }
  return count ? sum / count : null;
}

function runAggregation(dataset, aggregateFn) {
  const results = new Array(dataset.length);
  for (let i = 0; i < dataset.length; i += 1) {
    results[i] = aggregateFn(dataset[i]);
  }
  return results;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function benchmarkScale(scale, rng) {
  const nodeDataset = generateSamples(scale.points, NODE_COUNT, rng);
  const cardDataset = generateSamples(scale.points, TOTAL_CARDS, rng);

  for (let w = 0; w < WARMUP_RUNS; w += 1) {
    runAggregation(nodeDataset, averageNodeLevel);
    runAggregation(cardDataset, averageCardLevel);
  }

  const nodeDurations = [];
  const cardDurations = [];
  for (let r = 0; r < MEASURED_RUNS; r += 1) {
    const nodeStart = performance.now();
    runAggregation(nodeDataset, averageNodeLevel);
    nodeDurations.push(performance.now() - nodeStart);

    const cardStart = performance.now();
    runAggregation(cardDataset, averageCardLevel);
    cardDurations.push(performance.now() - cardStart);
  }

  const nodeLevelMs = mean(nodeDurations);
  const cardLevelMs = mean(cardDurations);

  return {
    '数据规模': scale.label,
    '时间点数': scale.points,
    '节点级平均耗时(ms)': nodeLevelMs.toFixed(3),
    '卡级平均耗时(ms)': cardLevelMs.toFixed(3),
    '倍数差异': `${(cardLevelMs / nodeLevelMs).toFixed(2)}x`,
  };
}

function main() {
  const rng = createRng(20260723);
  console.log(`节点数=${NODE_COUNT}，每节点卡数=${CARD_COUNT}，总卡数=${TOTAL_CARDS}，采样间隔=${SAMPLE_INTERVAL_SECONDS}秒`);
  console.log(`预热轮次=${WARMUP_RUNS}，测量轮次=${MEASURED_RUNS}\n`);

  const results = SCALES.map((scale) => benchmarkScale(scale, rng));
  console.table(results);
}

main();
