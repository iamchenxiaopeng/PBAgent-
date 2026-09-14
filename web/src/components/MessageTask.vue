<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  task: { type: Object, required: true }, // SessionMessage.task
});

const logs = ref([]);
const steps = ref([]);
const screenshot = ref('');
const status = ref(props.task.status ?? 'running');
const result = ref(null);
const errorMsg = ref('');
const stopping = ref(false);
const stopped = ref(false);
const showDetail = ref(false);

let es = null;

const actionLabel = (a) => {
  if (!a) return '';
  if (a.action === 'click' || a.action === 'fill') return a.ref != null ? `${a.action} #${a.ref}` : a.action;
  if (a.action === 'press') return `press ${a.key ?? ''}`;
  if (a.action === 'goto') return `goto ${(a.url || '').slice(0, 40)}`;
  if (a.action === 'wait') return `wait ${a.ms ?? '?'}ms`;
  if (a.action === 'log') return a.reason ? String(a.reason).slice(0, 40) : 'log';
  return a.action;
};

const costText = computed(() => {
  const c = result.value?.cost;
  if (!c || !c.llmCalls) return '零 LLM（$0）';
  const usd = c.usd !== null ? `$${c.usd.toFixed(4)}` : '未知单价';
  return `${c.llmCalls} 次调用 · ${c.tokensIn}+${c.tokensOut} tok · ${usd}`;
});

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

const stepTokens = (s) => {
  const u = s.usage;
  if (!u) return '';
  const inT = u.prompt_tokens ?? 0;
  const outT = u.completion_tokens ?? 0;
  if (!inT && !outT) return '';
  return `${inT}+${outT} tok`;
};

const stopTask = async () => {
  if (stopping.value || status.value !== 'running') return;
  stopping.value = true;
  try {
    const r = await fetch(`/api/tasks/${props.task.id}/stop`, { method: 'POST' });
    const d = await r.json();
    if (d.alreadyFinished) {
      stopping.value = false;
      return;
    }
    stopped.value = true;
  } catch {
    stopping.value = false;
  }
};

onMounted(() => {
  es = new EventSource(`/api/tasks/${props.task.id}/events`);
  es.addEventListener('log', (e) => {
    const { data } = JSON.parse(e.data);
    logs.value.push(data);
  });
  es.addEventListener('step', (e) => {
    const { data } = JSON.parse(e.data);
    steps.value.push(data);
    showDetail.value = true; // 有步骤自动展开时间线
  });
  es.addEventListener('screenshot', (e) => {
    const { data } = JSON.parse(e.data);
    screenshot.value = `data:image/png;base64,${data.base64}`;
  });
  es.addEventListener('done', (e) => {
    const { data } = JSON.parse(e.data);
    result.value = data;
    if (data.stopped) stopped.value = true;
    status.value = 'done';
    es.close();
  });
  es.addEventListener('error', (e) => {
    if (e.data) {
      const { data } = JSON.parse(e.data);
      errorMsg.value = data.message;
    }
    status.value = 'error';
    es.close();
  });
});

onBeforeUnmount(() => es?.close());

const statusText = computed(() => {
  if (status.value === 'running') return stopping.value ? '停止中…' : '执行中';
  if (status.value === 'error') return '执行出错';
  if (stopped.value) return '已停止';
  return result.value?.success ? '完成' : '已结束（目标未达成）';
});
</script>

<template>
  <div class="task-card" :class="[status]">
    <div class="tc-head" @click="showDetail = !showDetail">
      <span class="st-dot" :class="status"></span>
      <span class="st-text">{{ statusText }}</span>
      <span class="tc-summary" v-if="task.summary && status !== 'running'">{{ task.summary }}</span>
      <span class="tc-summary dim" v-else>{{ task.options?.task?.slice(0, 60) }}…</span>
      <span class="expand">{{ showDetail ? '收起' : '详情' }}</span>
    </div>

    <div class="tc-body" v-if="showDetail">
      <p v-if="errorMsg" class="err-banner">{{ errorMsg }}</p>

      <div class="tc-cols">
        <div class="tc-col">
          <div class="col-title">
            步骤时间线 <span class="count">{{ steps.length }}</span>
          </div>
          <div class="timeline">
            <div v-for="s in steps" :key="s.step" class="step" :class="{ ok: s.ok, fail: !s.ok }">
              <div class="step-head">
                <span class="no">{{ s.step }}</span>
                <code>{{ actionLabel(s.action) }}</code>
                <span class="engine-badge">{{ s.engine === 'cua' ? 'CUA' : 'PW' }}</span>
                <span class="ms" v-if="s.llmMs">🧠 {{ seconds(s.llmMs) }}</span>
                <span class="ms" v-if="stepTokens(s)">{{ stepTokens(s) }}</span>
                <span class="badge" :class="s.ok ? 'ok' : 'fail'">{{ s.ok ? '✓' : '✗' }}</span>
              </div>
              <div class="reason" v-if="s.action?.reason">{{ s.action.reason }}</div>
              <div class="detail url" v-if="s.afterUrl && s.afterUrl !== s.url">→ {{ s.afterUrl }}</div>
              <div class="detail err" v-if="s.error">{{ s.error }}</div>
            </div>
            <div v-if="!steps.length && status === 'running'" class="waiting">
              Agent 正在感知页面…（首次决策约需 5-20s）
            </div>
          </div>

          <div class="col-title" style="margin-top: 14px;">运行日志</div>
          <pre class="logs">{{ logs.join('\n') || '…' }}</pre>
        </div>

        <div class="tc-col">
          <div class="col-title">Agent 视角（截图）</div>
          <div class="shot-wrap">
            <img v-if="screenshot" :src="screenshot" alt="Agent 当前视角" />
            <div v-else class="shot-empty"><span class="spinner"></span>等待第一帧…</div>
          </div>
          <div class="result-card" v-if="result || status !== 'running'">
            <div class="kv" v-if="result"><span>总耗时</span><b>{{ seconds(result.totalMs) }}</b></div>
            <div class="kv" v-if="result"><span>Agent 步数</span><b>{{ result.steps.length }}</b></div>
            <div class="kv" v-if="result || task.llmCalls === 0"><span>LLM 成本</span><b>{{ costText }}</b></div>
          </div>
        </div>
      </div>
    </div>

    <div class="tc-foot" v-if="status === 'running'">
      <button class="btn danger" :disabled="stopping" @click.stop="stopTask">
        {{ stopping ? '停止中…' : '⏹ 停止任务（省 token）' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.task-card {
  background: transparent;
  border-radius: var(--radius);
  overflow: hidden;
}
.task-card.running { background: #f7f7f8; }
.task-card.error { background: rgba(179, 57, 46, 0.04); }

.tc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  cursor: pointer;
  user-select: none;
}
.tc-head:hover { background: rgba(0, 0, 0, 0.03); }
.st-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.st-dot.running { background: var(--warn); animation: pulse 1.2s infinite; }
.st-dot.done { background: var(--ok); }
.st-dot.error { background: var(--err); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.st-text { font-size: 12.5px; font-weight: 700; color: var(--text); flex-shrink: 0; }
.tc-summary { font-size: 12.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.tc-summary.dim { color: var(--text-faint); }
.expand { font-size: 11.5px; color: var(--text-faint); flex-shrink: 0; }

.tc-body { padding: 14px; }
.err-banner {
  background: rgba(179, 57, 46, 0.08);
  color: var(--err);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
  font-size: 12.5px;
}

.tc-cols { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 16px; }
@media (max-width: 860px) { .tc-cols { grid-template-columns: 1fr; } }
.tc-col { min-width: 0; }

.col-title {
  font-size: 11.5px; color: var(--text-faint); margin-bottom: 10px;
  text-transform: uppercase; letter-spacing: 0.5px;
}
.count {
  background: var(--bg-elevated); color: var(--text-dim);
  border-radius: 999px; font-size: 10.5px; padding: 1px 7px; margin-left: 4px;
}

.timeline { max-height: 300px; overflow-y: auto; }
.step {
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin-bottom: 6px;
  background: #f7f7f8;
}
.step.fail { background: rgba(179, 57, 46, 0.05); }
.step-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.no { font-size: 11px; color: var(--text-faint); font-family: var(--mono); }
.step-head code {
  font-family: var(--mono); font-size: 11.5px; color: var(--text);
  background: #ffffff; padding: 2px 6px; border-radius: 4px;
}
.engine-badge {
  font-size: 10px; color: var(--text-dim);
  background: #ffffff; border-radius: 4px; padding: 1px 5px;
}
.ms { font-size: 10.5px; color: var(--text-faint); }
.badge { font-size: 11px; margin-left: auto; }
.badge.ok { color: var(--ok); }
.badge.fail { color: var(--err); }
.reason { font-size: 12px; color: var(--text-dim); margin-top: 5px; }
.detail { font-size: 11.5px; color: var(--text-faint); margin-top: 4px; word-break: break-all; }
.detail.err { color: var(--err); }
.waiting { font-size: 12px; color: var(--text-faint); padding: 14px 0; text-align: center; }

.logs {
  background: #f7f7f8;
  border-radius: var(--radius-sm);
  padding: 10px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.shot-wrap {
  background: #f7f7f8;
  border-radius: var(--radius-sm);
  min-height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.shot-wrap img { max-width: 100%; display: block; }
.shot-empty { font-size: 12px; color: var(--text-faint); display: flex; align-items: center; gap: 8px; }
.spinner {
  width: 12px; height: 12px; border: 2px solid var(--border);
  border-top-color: var(--text-dim); border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.result-card {
  margin-top: 10px;
  background: #f7f7f8;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.kv { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
.kv:last-child { margin-bottom: 0; }
.kv span { color: var(--text-faint); }
.kv b { color: var(--text-dim); font-weight: 500; font-family: var(--mono); }

.tc-foot {
  padding: 10px 14px;
  display: flex;
  justify-content: flex-end;
}
</style>
