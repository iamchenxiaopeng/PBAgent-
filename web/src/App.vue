<script setup>
import { ref, reactive, onMounted } from 'vue';
import Sidebar from './components/Sidebar.vue';
import HomeView from './components/HomeView.vue';
import SessionView from './components/SessionView.vue';
import SettingsPanel from './components/SettingsPanel.vue';

const view = ref('home'); // home | session
const activeSession = ref(null); // { id, title }
const settingsOpen = ref(false);
const health = reactive({ loaded: false, llm: { configured: false, model: '' } });
/** 会话列表变更信号（Sidebar 与主区共享：新建/删除后刷新） */
const sessionsVersion = ref(0);

const openSession = (s) => {
  activeSession.value = s;
  view.value = 'session';
};

const goHome = () => {
  view.value = 'home';
  activeSession.value = null;
};

const refreshSessions = () => {
  sessionsVersion.value++;
};

onMounted(() => {
  fetch('/api/health')
    .then((r) => r.json())
    .then((d) => {
      health.llm = d.llm;
      health.loaded = true;
    })
    .catch(() => { health.loaded = true; });
});
</script>

<template>
  <div class="app-shell">
    <Sidebar
      :active-id="activeSession?.id ?? null"
      :version="sessionsVersion"
      @select="openSession"
      @new="goHome"
      @open-settings="settingsOpen = true"
    />
    <main class="main-area">
      <HomeView
        v-if="view === 'home'"
        :health="health"
        @session-started="openSession"
        @sessions-changed="refreshSessions"
      />
      <SessionView
        v-else-if="view === 'session' && activeSession"
        :key="activeSession.id"
        :session="activeSession"
        :health="health"
        @back="goHome"
        @sessions-changed="refreshSessions"
      />
    </main>
    <SettingsPanel v-if="settingsOpen" :health="health" @close="settingsOpen = false" />
  </div>
</template>

<style>
@import './styles/theme.css';

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body, #app { height: 100%; }

body {
  font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}

.app-shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  height: 100vh;
  overflow: hidden;
}

.main-area {
  overflow-y: auto;
  background: var(--bg);
}

/* 通用滚动条（细条） */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: #d9d9de; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
::-webkit-scrollbar-track { background: transparent; }

/* 通用按钮（无 border，背景层级区分） */
.btn {
  border: none;
  background: var(--bg-elevated);
  color: var(--text);
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.12s;
}
.btn:hover { background: #e4e4e8; }
.btn.primary {
  background: var(--accent);
  color: var(--accent-text);
  font-weight: 600;
}
.btn.primary:hover { background: #000; }
.btn.danger { color: var(--err); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* 通用输入框（白底 + 细边框——输入框是少数保留 border 的元素） */
.input {
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 10px 12px;
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.12s;
  width: 100%;
}
.input:focus { border-color: var(--text-faint); }
.input::placeholder { color: var(--text-faint); }
</style>
