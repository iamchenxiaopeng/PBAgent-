<script setup>
import { ref, reactive, nextTick, onMounted } from 'vue';
import MessageTask from './MessageTask.vue';

const props = defineProps({
  session: { type: Object, required: true },
  health: Object,
});
const emit = defineEmits(['back', 'sessions-changed']);

const messages = ref([]);
const loading = ref(true);
const title = ref(props.session.title ?? '');
const input = ref('');
const submitting = ref(false);
const error = ref('');
const showPlaybooks = ref(false);
const playbookItems = ref([]);
const messagesEl = ref(null);

/** 会话内最后任务的 URL（多轮追问的继承源，前端展示用） */
const lastUrl = ref('');
const lastParams = ref({});

const scrollBottom = async () => {
  await nextTick();
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
};

const load = async () => {
  try {
    const r = await fetch(`/api/sessions/${props.session.id}`);
    if (r.ok) {
      const s = await r.json();
      messages.value = s.messages ?? [];
      title.value = s.title;
      const last = [...messages.value].reverse().find((m) => m.task?.options?.url);
      if (last) {
        lastUrl.value = last.task.options.url;
        lastParams.value = last.task.options.params ?? {};
      }
    }
  } catch { /* 忽略 */ }
  loading.value = false;
  scrollBottom();
};
onMounted(load);

/** 设置里的 LLM 默认值（与 HomeView 同源） */
const defaults = reactive({ learnMode: 'on-failure', routeMode: 'intent' });
try {
  const raw = localStorage.getItem('pbagent-settings');
  if (raw) Object.assign(defaults, JSON.parse(raw));
} catch { /* 忽略 */ }
// 旧版本 learn:boolean 迁移
if (defaults.learnMode === undefined) {
  defaults.learnMode = defaults.learn === false ? 'off' : 'on-failure';
}
if (defaults.routeMode === undefined) defaults.routeMode = 'intent';

const llmBody = () => {
  const o = {};
  if (defaults.baseUrl) o.baseUrl = defaults.baseUrl;
  if (defaults.apiKey) o.apiKey = defaults.apiKey;
  if (defaults.model) o.model = defaults.model;
  return Object.keys(o).length ? { llm: o } : {};
};

/** 发送新指令：多轮追问（URL 继承自会话上下文，后端处理） */
const send = async () => {
  const text = input.value.trim();
  if (!text || submitting.value) return;
  submitting.value = true;
  error.value = '';
  // 乐观渲染用户消息（后端也会落盘；刷新时以服务端为准）
  messages.value.push({ id: `local-${Date.now()}`, role: 'user', at: Date.now(), text });
  input.value = '';
  scrollBottom();
  try {
    const resp = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: text,
        maxSteps: defaults.maxSteps ?? null,
        headed: Boolean(defaults.headed),
        learnMode: defaults.learnMode || 'on-failure',
        routeMode: defaults.routeMode || 'intent',
        sessionId: props.session.id,
        ...llmBody(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `提交失败（${resp.status}）`);
    messages.value.push({
      id: `task-${data.id}`,
      role: 'assistant',
      at: Date.now(),
      task: { id: data.id, status: 'running', options: { task: text } },
    });
    emit('sessions-changed');
    scrollBottom();
  } catch (e) {
    error.value = e.message;
    // 回滚乐观渲染
    messages.value = messages.value.filter((m) => !String(m.id).startsWith('local-'));
  } finally {
    submitting.value = false;
  }
};

const togglePlaybooks = async () => {
  showPlaybooks.value = !showPlaybooks.value;
  if (showPlaybooks.value && !playbookItems.value.length) {
    try {
      const r = await fetch('/api/playbooks');
      const d = await r.json();
      playbookItems.value = d.items ?? [];
    } catch { /* 忽略 */ }
  }
};

const runPlaybookInSession = (pb) => {
  const file = pb.files?.find((f) => f.isCurrent) ?? pb.files?.[0];
  if (!file) return;
  input.value = `/run ${pb.name}`;
  showPlaybooks.value = false;
  error.value = `沉淀流程《${pb.name}》请通过主页运行（会话内快捷运行待 v2.1）`;
};

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <div class="session-view">
    <header class="sess-head">
      <button class="back-btn" @click="emit('back')" title="返回主页">←</button>
      <div class="sess-title">{{ title }}</div>
      <div class="sess-meta" v-if="lastUrl">
        <span class="url-chip" :title="lastUrl">{{ lastUrl }}</span>
      </div>
      <button class="btn" @click="togglePlaybooks">⚡ 沉淀流程</button>
    </header>

    <div v-if="showPlaybooks" class="pb-drawer">
      <div v-if="!playbookItems.length" class="pb-empty">暂无沉淀流程</div>
      <div v-for="pb in playbookItems" :key="pb.name" class="pb-item" @click="runPlaybookInSession(pb)">
        <span class="pb-name">{{ pb.name }}</span>
        <span class="pb-meta">当前 v{{ pb.currentVersion }} · {{ pb.totalVersions }} 个版本</span>
      </div>
    </div>

    <div class="messages" ref="messagesEl">
      <div v-if="loading" class="loading">加载会话…</div>
      <template v-else>
        <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
          <div v-if="m.role === 'user'" class="bubble user-bubble">{{ m.text }}</div>
          <div v-else-if="m.task" class="bubble agent-bubble">
            <MessageTask :task="m.task" :key="m.task.id" />
          </div>
        </div>
        <div v-if="!messages.length" class="empty">
          <p>会话已创建。发送第一条指令开始——</p>
          <p class="dim">URL 等上下文会从上一轮自动继承，只需说这一轮要做什么。</p>
        </div>
      </template>
    </div>

    <div class="composer-bar">
      <p v-if="error" class="error">{{ error }}</p>
      <div class="input-row">
        <textarea
          class="input"
          v-model="input"
          rows="1"
          placeholder="继续下达指令…（如：把 S050 价格再改成 300）Ctrl+Enter 发送"
          @keyup.ctrl.enter="send"
          @input="(e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }"
        ></textarea>
        <button class="btn primary send-btn" :disabled="!input.trim() || submitting" @click="send">
          {{ submitting ? '…' : '发送' }}
        </button>
      </div>
      <div class="bar-hint">
        <span>上下文继承：{{ lastUrl ? `同域连续操作（${lastUrl}）` : '首条指令需含 URL（在主页填写）' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.sess-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: transparent;
  flex-shrink: 0;
}
.back-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}
.back-btn:hover { color: var(--text); background: var(--bg-hover); }
.sess-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}
.sess-meta { flex: 1; min-width: 0; }
.url-chip {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  background: var(--bg-elevated);
  padding: 3px 8px;
  border-radius: 999px;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.pb-drawer {
  background: #f7f7f8;
  border-radius: var(--radius-sm);
  margin: 8px 16px 0;
  padding: 10px;
  max-height: 200px;
  overflow-y: auto;
  flex-shrink: 0;
}
.pb-empty { font-size: 12px; color: var(--text-faint); }
.pb-item {
  display: flex;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.pb-item:hover { background: var(--bg-hover); }
.pb-name { font-family: var(--mono); font-size: 12.5px; color: var(--text); }
.pb-meta { font-size: 11.5px; color: var(--text-faint); }

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px 0;
}
.loading, .empty { text-align: center; color: var(--text-faint); font-size: 13px; padding: 40px 0; }
.empty .dim { font-size: 12px; margin-top: 8px; color: var(--text-faint); }

.msg { padding: 6px 24px; margin-bottom: 10px; }
.msg.user { display: flex; justify-content: flex-end; }
.user-bubble {
  background: #f7f7f8;
  color: var(--text);
  padding: 10px 14px;
  border-radius: 12px 12px 4px 12px;
  max-width: 72%;
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-bubble { max-width: 100%; }

.composer-bar {
  background: transparent;
  padding: 12px 20px 10px;
  flex-shrink: 0;
}
.error { color: var(--err); font-size: 12px; margin-bottom: 8px; }
.input-row { display: flex; gap: 10px; align-items: flex-end; }
.input-row .input {
  resize: none;
  line-height: 1.5;
  max-height: 120px;
  font-size: 13.5px;
}
.send-btn { flex-shrink: 0; }
.bar-hint { margin-top: 6px; font-size: 11px; color: var(--text-faint); }
</style>
