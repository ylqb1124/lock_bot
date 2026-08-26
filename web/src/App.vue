<script setup>
import { computed, ref } from 'vue';
import { loginDashboard, logoutDashboard } from './services/api.js';
import ClusterDashboard from './views/ClusterDashboard.vue';
import TeamDashboard from './views/TeamDashboard.vue';

const SESSION_KEY = 'xpu-monitor-session';
const SESSION_TTL = 4 * 60 * 60 * 1000;
const restored = restoreSession();
const token = ref(restored?.token || '');
const username = ref(restored?.username || '');
const mode = ref(restored?.mode || '');
const password = ref('');
const loginError = ref('');
const loggingIn = ref(false);

const loggedIn = computed(() => Boolean(token.value));
const isTeamView = computed(() => {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  return pathname === '/team';
});
// 集群总览覆盖全部节点，只有 admin 账号（mode: 'all'）可见；团队账号访问 /app 时提示无权访问。
const clusterAccessDenied = computed(() => !isTeamView.value && mode.value !== 'all');

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
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: token.value, username: username.value, mode: mode.value, savedAt: Date.now() }));
}

function logout() {
  const activeToken = token.value;
  token.value = '';
  password.value = '';
  localStorage.removeItem(SESSION_KEY);
  void logoutDashboard(activeToken);
}

async function login() {
  if (!username.value.trim() || !password.value) {
    loginError.value = '请输入用户名和密码';
    return;
  }
  loggingIn.value = true;
  loginError.value = '';
  try {
    const session = await loginDashboard(username.value.trim(), password.value);
    token.value = session.token;
    username.value = session.username;
    mode.value = session.mode;
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
      <h1>登录资源监控</h1>
      <label>用户名<input v-model="username" autocomplete="username" /></label>
      <label>密码<input v-model="password" type="password" autocomplete="current-password" /></label>
      <p v-if="loginError" class="form-error">{{ loginError }}</p>
      <button class="primary-button login-button" type="submit" :disabled="loggingIn">{{ loggingIn ? '登录中...' : '登录' }}</button>
    </form>
  </div>
  <TeamDashboard v-else-if="isTeamView" :token="token" @expired="logout" />
  <div v-else-if="clusterAccessDenied" class="login-page">
    <div class="login-card">
      <p class="eyebrow">开发机集群资源监控</p>
      <h1>该账号无权访问</h1>
      <p class="form-error">当前账号仅可查看所属团队的资源视图，无法访问集群总览。</p>
      <a class="primary-button login-button" href="/team">前往团队视图</a>
    </div>
  </div>
  <ClusterDashboard v-else :token="token" @expired="logout" />
</template>
