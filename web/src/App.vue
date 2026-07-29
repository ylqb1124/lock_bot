<script setup>
import { computed, ref } from 'vue';
import { fetchLockBotList, loginLockBot } from './services/api.js';
import ClusterDashboard from './views/ClusterDashboard.vue';
import TeamDashboard from './views/TeamDashboard.vue';

const SESSION_KEY = 'xpu-monitor-session';
const SESSION_TTL = 4 * 60 * 60 * 1000;
const restored = restoreSession();
const token = ref(restored?.token || '');
const username = ref(restored?.username || '');
const password = ref('');
const loginError = ref('');
const loggingIn = ref(false);

const loggedIn = computed(() => Boolean(token.value));
const isTeamView = computed(() => {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  return pathname === '/team';
});

function restoreSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (value?.token && Date.now() - value.savedAt < SESSION_TTL) return value;
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Session restoration is optional.
  }
  return null;
}

function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: token.value, username: username.value, savedAt: Date.now() }));
}

function logout() {
  token.value = '';
  password.value = '';
  localStorage.removeItem(SESSION_KEY);
}

async function login() {
  if (!username.value.trim() || !password.value) {
    loginError.value = '请输入用户名和密码';
    return;
  }
  loggingIn.value = true;
  loginError.value = '';
  try {
    const nextToken = await loginLockBot(username.value.trim(), password.value);
    const availableBots = await fetchLockBotList(nextToken);
    if (!Array.isArray(availableBots) || !availableBots.length) throw new Error('当前账号没有可用 Bot');
    token.value = nextToken;
    password.value = '';
    saveSession();
  } catch (error) {
    loginError.value = error?.message || '登录失败';
  } finally {
    loggingIn.value = false;
  }
}
</script>

<template>
  <div v-if="!loggedIn" class="login-page">
    <form class="login-card" @submit.prevent="login">
      <p class="eyebrow">开发机集群资源监控</p>
      <h1>登录 Lock Bot</h1>
      <label>用户名<input v-model="username" autocomplete="username" /></label>
      <label>密码<input v-model="password" type="password" autocomplete="current-password" /></label>
      <p v-if="loginError" class="form-error">{{ loginError }}</p>
      <button class="primary-button login-button" type="submit" :disabled="loggingIn">{{ loggingIn ? '登录中...' : '登录' }}</button>
    </form>
  </div>
  <TeamDashboard v-else-if="isTeamView" :token="token" @expired="logout" />
  <ClusterDashboard v-else :token="token" @expired="logout" />
</template>
