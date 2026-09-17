<script setup>
import { ref, onMounted, watch } from 'vue';

const props = defineProps({
  activeId: { type: String, default: null },
  activeView: { type: String, default: 'home' },
  version: { type: Number, default: 0 },
});
const emit = defineEmits(['select', 'new', 'open-drafts', 'open-settings']);

const sessions = ref([]);
const loading = ref(true);
const renamingId = ref(null);
const renameText = ref('');
const confirmDeleteId = ref(null);

const load = async () => {
  try {
    const r = await fetch('/api/sessions?limit=100');
    const d = await r.json();
    sessions.value = d.items ?? [];
  } catch { /* 静默 */ }
  loading.value = false;
};

onMounted(load);
watch(() => props.version, load);

const fmtTime = (ts) => {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};

const startRename = (s) => {
  renamingId.value = s.id;
  renameText.value = s.title;
  confirmDeleteId.value = null;
};

const commitRename = async () => {
  const id = renamingId.value;
  const title = renameText.value.trim();
  renamingId.value = null;
  if (!id || !title) return;
  const s = sessions.value.find((x) => x.id === id);
  if (s && s.title === title) return;
  await fetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).catch(() => {});
  load();
};

const askDelete = (s) => {
  confirmDeleteId.value = confirmDeleteId.value === s.id ? null : s.id;
  renamingId.value = null;
};

const commitDelete = async (id) => {
  confirmDeleteId.value = null;
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  if (props.activeId === id) emit('new');
  load();
};
</script>

<template>
  <aside class="sidebar">
    <div class="side-head">
      <span class="brand">PB</span>
      <span class="brand-name">PBAgent</span>
    </div>

    <button class="new-btn" @click="emit('new')">
      <span class="plus">+</span> 新会话
    </button>

    <button class="nav-btn" :class="{ active: props.activeView === 'drafts' }" @click="emit('open-drafts')">
      <span class="nav-icon">⚡</span> 沉淀库
    </button>

    <div class="session-list">
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!sessions.length" class="empty">暂无历史会话</div>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === activeId }"
        @click="emit('select', s)"
      >
        <template v-if="renamingId === s.id">
          <input
            class="rename-input"
            v-model="renameText"
            @keyup.enter="commitRename"
            @keyup.esc="renamingId = null"
            @click.stop
            autofocus
          />
        </template>
        <template v-else>
          <div class="s-title">{{ s.title }}</div>
          <div class="s-meta">
            <span>{{ fmtTime(s.updatedAt) }}</span>
            <span v-if="s.messageCount">{{ s.messageCount }} 条</span>
          </div>
          <div class="s-actions" @click.stop>
            <button class="icon-btn" title="重命名" @click="startRename(s)">✎</button>
            <button class="icon-btn" title="删除" @click="askDelete(s)">🗑</button>
          </div>
          <div v-if="confirmDeleteId === s.id" class="confirm-del" @click.stop>
            <span>删除该会话？</span>
            <button class="mini danger" @click="commitDelete(s.id)">删除</button>
            <button class="mini" @click="confirmDeleteId = null">取消</button>
          </div>
        </template>
      </div>
    </div>

    <div class="side-foot">
      <button class="settings-btn" @click="emit('open-settings')">
        <span class="gear">⚙</span> 设置
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--hairline);
  height: 100vh;
  overflow: hidden;
}

.side-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 16px 12px;
}
.brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: -0.5px;
}
.brand-name { font-size: 14px; font-weight: 700; color: var(--text); }

.new-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 12px 10px;
  padding: 9px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.12s;
}
.new-btn:hover { color: var(--text); background: #e4e4e8; }
.plus { font-size: 15px; line-height: 1; }

.nav-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 10px;
  padding: 9px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.12s;
}
.nav-btn:hover { color: var(--text); background: var(--bg-hover); }
.nav-btn.active { color: var(--text); background: var(--bg-panel); font-weight: 600; }
.nav-icon { font-size: 12px; }

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
}
.empty { color: var(--text-faint); font-size: 12.5px; text-align: center; padding: 24px 0; }

.session-item {
  position: relative;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.1s;
}
.session-item:hover { background: var(--bg-hover); }
.session-item.active { background: var(--bg-panel); }

.s-title {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 44px;
}
.session-item.active .s-title { font-weight: 600; }
.s-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 3px;
}

.s-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: none;
  gap: 2px;
}
.session-item:hover .s-actions { display: flex; }
.icon-btn {
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 12px;
  padding: 3px 5px;
  border-radius: 4px;
}
.icon-btn:hover { color: var(--text); background: #ffffff; }

.confirm-del {
  margin-top: 8px;
  padding: 8px;
  background: #ffffff;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.mini {
  border: none;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 4px;
  cursor: pointer;
}
.mini:hover { color: var(--text); background: #e4e4e8; }
.mini.danger { color: var(--err); background: rgba(179, 57, 46, 0.08); }

.rename-input {
  width: 100%;
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-size: 13px;
  padding: 6px 8px;
  outline: none;
}

.side-foot {
  border-top: 1px solid var(--hairline);
  padding: 10px 12px;
}
.settings-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.12s;
}
.settings-btn:hover { color: var(--text); background: var(--bg-hover); }
.gear { font-size: 14px; }
</style>
