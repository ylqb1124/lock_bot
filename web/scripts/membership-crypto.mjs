#!/usr/bin/env node
// 花名册加解密工具。用法：
//   node scripts/membership-crypto.mjs keygen
//   TEAM_MEMBERSHIP_KEY=... node scripts/membership-crypto.mjs encrypt <明文json> <输出文件>
//   TEAM_MEMBERSHIP_KEY=... node scripts/membership-crypto.mjs decrypt <密文json> [输出文件]
//   TEAM_MEMBERSHIP_KEY=... node scripts/membership-crypto.mjs inspect <文件>
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _private: teamPrivate } = require('../server/team-service.cjs');
const { membershipKey, encryptMembership, decryptMembership, MEMBERSHIP_KEY_ENV } = teamPrivate;

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

function requireKey() {
  let key;
  try {
    key = membershipKey();
  } catch (error) {
    fail(error.message);
  }
  if (!key) fail(`未设置环境变量 ${MEMBERSHIP_KEY_ENV}`);
  return key;
}

function readJson(filePath) {
  if (!filePath) fail('缺少输入文件路径');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${filePath}：${error.message}`);
  }
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

const [command, input, output] = process.argv.slice(2);

if (command === 'keygen') {
  console.log(crypto.randomBytes(32).toString('base64'));
  process.exit(0);
}

if (command === 'encrypt') {
  const key = requireKey();
  const plain = readJson(input);
  if (plain?.format === 'aes-256-gcm') fail('输入文件已是密文');
  if (!plain?.assignments || typeof plain.assignments !== 'object') fail('输入文件缺少 assignments 对象');
  if (!output) fail('缺少输出文件路径');
  writeJson(output, encryptMembership(plain, key));
  console.log(`已加密 ${Object.keys(plain.assignments).length} 条归属 → ${output}`);
  process.exit(0);
}

if (command === 'decrypt') {
  const key = requireKey();
  const envelope = readJson(input);
  if (envelope?.format !== 'aes-256-gcm') fail('输入文件不是本工具生成的密文');
  let plain;
  try {
    plain = decryptMembership(envelope, key);
  } catch {
    fail('解密失败：密钥不匹配或文件已被篡改');
  }
  if (output) {
    writeJson(output, plain);
    console.log(`已解密 ${Object.keys(plain.assignments).length} 条归属 → ${output}`);
  } else {
    console.log(JSON.stringify(plain, null, 2));
  }
  process.exit(0);
}

if (command === 'inspect') {
  const raw = readJson(input);
  if (raw?.format !== 'aes-256-gcm') {
    console.log(`明文，${Object.keys(raw?.assignments || {}).length} 条归属`);
    process.exit(0);
  }
  const key = requireKey();
  try {
    const plain = decryptMembership(raw, key);
    console.log(`密文，密钥可用，${Object.keys(plain.assignments).length} 条归属，generatedAt=${plain.generatedAt}`);
  } catch {
    fail('密文存在但当前密钥无法解密');
  }
  process.exit(0);
}

console.error('用法：membership-crypto.mjs <keygen|encrypt|decrypt|inspect> [输入] [输出]');
process.exit(1);
