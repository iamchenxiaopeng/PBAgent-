<script setup>
import { ref, reactive, onMounted } from 'vue';

const props = defineProps({ health: Object });
const emit = defineEmits(['session-started', 'sessions-changed']);

/** 设置里持久化的默认值（SettingsPanel 写 localStorage） */
const defaults = reactive({ headed: false, maxSteps: null, baseUrl: '', apiKey: '', model: '' });
const loadDefaults = () => {
  try {
    const raw = localStorage.getItem('pbagent-settings');
    if (raw) Object.assign(defaults, JSON.parse(raw));
  } catch { /* 忽略 */ }
};
onMounted(loadDefaults);

/** 内联选项改动即存（SessionView/SettingsPanel 同源读写） */
const persistDefaults = () => {
  const ms = defaults.maxSteps;
  const normalized = (ms === '' || ms === null || Number.isNaN(Number(ms))) ? null : Math.max(1, Math.round(Number(ms)));
  defaults.maxSteps = normalized;
  localStorage.setItem('pbagent-settings', JSON.stringify({ ...defaults }));
};

const url = ref('');
const task = ref('');
const submitting = ref(false);
const matching = ref(false);
const error = ref('');
/** 沉淀流程命中（null = 未命中/未检索） */
const matchHit = ref(null);
const paramValues = reactive({});
const paramError = ref('');

/** 沉淀流程快捷卡（主页展示已沉淀的流程） */
const playbooks = ref([]);
onMounted(async () => {
  try {
    const r = await fetch('/api/playbooks');
    const d = await r.json();
    playbooks.value = (d.items ?? []).filter((p) => p.currentVersion >= 1).slice(0, 4);
  } catch { /* 忽略 */ }
});

const llmBody = () => {
  const o = {};
  if (defaults.baseUrl) o.baseUrl = defaults.baseUrl;
  if (defaults.apiKey) o.apiKey = defaults.apiKey;
  if (defaults.model) o.model = defaults.model;
  return Object.keys(o).length ? { llm: o } : {};
};

const buildBody = () => ({
  url: url.value.trim(),
  task: task.value.trim(),
  maxSteps: defaults.maxSteps ?? null,
  headed: Boolean(defaults.headed),
  ...llmBody(),
});

/** 提交：先建会话 → 检索沉淀流程（命中弹卡）或直接提交任务 */
const submit = async () => {
  if (!url.value || !task.value) {
    error.value = '起始 URL 和任务描述都不能为空';
    return;
  }
  submitting.value = true;
  matching.value = true;
  matchHit.value = null;
  paramError.value = '';
  error.value = '';
  try {
    // 1. 建会话（首条指令作标题）
    const sResp = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: task.value.trim() }),
    });
    if (!sResp.ok) throw new Error('会话创建失败');
    const session = await sResp.json();

    // 2. 检索沉淀流程（失败不阻断）
    const body = buildBody();
    try {
      const mResp = await fetch('/api/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: body.task, url: body.url, llm: body.llm }),
      });
      if (mResp.ok) {
        const m = await mResp.json();
        if (m.matched && m.playbook) {
          for (const p of m.playbook.params || []) {
            const m2 = task.value.match(new RegExp(`${p}\\s*[是为=:：]?\\s*([\\w.\\-]+)`, 'i'));
            paramValues[p] = m2 ? m2[1] : '';
          }
          matchHit.value = { ...m.playbook, reason: m.reason, body, sessionId: session.id };
          return; // 等用户选择
        }
      }
    } catch { /* 检索失败静默降级 */ }

    // 3. 未命中：直接提交 Agent 任务
    await postTask({ ...body, sessionId: session.id });
  } catch (e) {
    error.value = e.message;
  } finally {
    submitting.value = false;
    matching.value = false;
  }
};

const runPlaybook = async () => {
  const hit = matchHit.value;
  if (!hit) return;
  const missing = (hit.params || []).filter((p) => !String(paramValues[p] ?? '').trim());
  if (missing.length) {
    paramError.value = `还有参数未填写：${missing.join('、')}`;
    return;
  }
  submitting.value = true;
  try {
    const params = {};
    for (const p of hit.params || []) params[p] = paramValues[p] ?? '';
    await postTask({ ...hit.body, playbookFile: hit.file, params, sessionId: hit.sessionId });
  } catch (e) {
    error.value = e.message;
  } finally {
    submitting.value = false;
    matchHit.value = null;
  }
};

const runAgentMode = async () => {
  const hit = matchHit.value;
  if (!hit) return;
  submitting.value = true;
  try {
    await postTask({ ...hit.body, sessionId: hit.sessionId });
  } catch (e) {
    error.value = e.message;
  } finally {
    submitting.value = false;
    matchHit.value = null;
  }
};

/** 快捷卡直接跑沉淀流程（点击后进入会话并补参数/直接跑） */
const quickRun = async (pb) => {
  if (!url.value) {
    error.value = '请先填写起始 URL（沉淀流程的入口页）';
    return;
  }
  task.value = `执行沉淀流程《${pb.name}》`;
  await submit();
};

const postTask = async (body) => {
  const resp = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `提交失败（${resp.status}）`);
  emit('sessions-changed');
  emit('session-started', { id: body.sessionId, title: body.task.slice(0, 40) });
};

const canSubmit = () => Boolean(url.value.trim() && task.value.trim()) && !submitting.value;
</script>

<template>
  <div class="home">
    <div class="hero">
      <h1>PBAgent</h1>
      <p class="tagline">自然语言驱动 · Playbook + LLM 混合式浏览器操作 Agent</p>
      <p class="llm-status" v-if="props.health?.loaded">
        <template v-if="props.health.llm.configured">默认模型：{{ props.health.llm.model }}</template>
        <template v-else>未配置默认 LLM——在左下角设置里填写 Key</template>
      </p>
    </div>

    <div class="composer">
      <input
        class="input url-input"
        v-model="url"
        placeholder="起始 URL（https://admin.example.com/login）"
        spellcheck="false"
        @keyup.enter="() => { if (canSubmit()) submit(); }"
      />
      <textarea
        class="input task-input"
        v-model="task"
        rows="3"
        placeholder="描述任务，如：用户名 demo 密码 demo123 登录，然后给商品 S050 改价 200 并确认"
        @keyup.ctrl.enter="() => { if (canSubmit()) submit(); }"
      ></textarea>
      <div class="composer-foot">
        <div class="quick-opts">
          <label class="opt-check">
            <input type="checkbox" v-model="defaults.headed" @change="persistDefaults" />
            <span>有头模式</span>
          </label>
          <label class="opt-steps">
            <span>最大步数</span>
            <input
              class="input"
              type="number"
              min="1"
              max="200"
              placeholder="不限"
              v-model="defaults.maxSteps"
              @change="persistDefaults"
            />
          </label>
        </div>
        <button class="btn primary" :disabled="!canSubmit()" @click="submit">
          {{ matching ? '检索沉淀流程…' : submitting ? '提交中…' : '开始' }}
        </button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </div>

    <div v-if="matchHit" class="match-card">
      <div class="match-title">⚡ 检测到已沉淀的流程</div>
      <div class="match-pb">
        <b>《{{ matchHit.name }}》</b>
        <span class="match-desc">{{ matchHit.description || '（无描述）' }}</span>
      </div>
      <div class="match-meta">
        {{ matchHit.stepCount }} 步 · 当前 v{{ matchHit.currentVersion || 1 }} · 匹配理由：{{ matchHit.reason }}
      </div>

      <div v-if="matchHit.params && matchHit.params.length" class="param-box">
        <div class="param-title">该流程需要以下参数：</div>
        <div class="param-grid">
          <label v-for="p in matchHit.params" :key="p" class="param-field">
            <span>{{ p }}</span>
            <input class="input" v-model="paramValues[p]" :placeholder="`请输入 ${p} 的值`" spellcheck="false" />
          </label>
        </div>
        <p v-if="paramError" class="error">{{ paramError }}</p>
      </div>

      <div class="match-actions">
        <button class="btn primary" :disabled="submitting" @click="runPlaybook">⚡ 零 LLM 直接执行（$0）</button>
        <button class="btn" :disabled="submitting" @click="runAgentMode">🤖 用 Agent 模式跑</button>
      </div>
      <p class="match-hint">沉淀流程为确定性执行——不消耗任何 token；Agent 模式由 LLM 现场决策（会产生成本）</p>
    </div>

    <div v-if="playbooks.length" class="quick-card">
      <div class="quick-title">已沉淀流程</div>
      <div class="quick-list">
        <button v-for="pb in playbooks" :key="pb.name" class="quick-item" @click="quickRun(pb)">
          <span class="q-name">{{ pb.name }}</span>
          <span class="q-meta">v{{ pb.currentVersion || 1 }} · {{ pb.stepCount ?? '?' }} 步</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 8vh 24px 48px;
}

.hero { text-align: center; margin-bottom: 36px; }
.hero h1 {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.5px;
  color: var(--text);
}
.tagline { color: var(--text-dim); font-size: 13px; margin-top: 8px; }
.llm-status { color: var(--text-faint); font-size: 12px; margin-top: 4px; }

.composer {
  background: transparent;
  padding: 0;
}
.url-input { margin-bottom: 10px; font-size: 13px; }
.task-input { resize: vertical; line-height: 1.6; min-height: 76px; }
.composer-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
  gap: 12px;
  flex-wrap: wrap;
}
.quick-opts { display: flex; align-items: center; gap: 16px; }
.opt-check {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  user-select: none;
}
.opt-check input { width: 14px; height: 14px; cursor: pointer; margin: 0; }
.opt-check span { font-size: 12.5px; color: var(--text-dim); }
.opt-steps {
  display: flex;
  align-items: center;
  gap: 7px;
}
.opt-steps > span { font-size: 12.5px; color: var(--text-dim); white-space: nowrap; }
.opt-steps .input {
  width: 84px;
  padding: 5px 9px;
  font-size: 12.5px;
  text-align: center;
}
.hint { font-size: 11.5px; color: var(--text-faint); }
.error { color: var(--err); font-size: 12.5px; margin-top: 10px; }

.match-card {
  margin-top: 18px;
}
.match-title { font-size: 13.5px; font-weight: 700; color: var(--text); margin-bottom: 10px; }
.match-pb { font-size: 14px; margin-bottom: 6px; }
.match-pb b { color: var(--text); }
.match-desc { color: var(--text-dim); font-size: 12.5px; margin-left: 6px; }
.match-meta { font-size: 12px; color: var(--text-faint); margin-bottom: 14px; }
.param-box {
  margin-bottom: 14px;
}
.param-title { font-size: 12.5px; font-weight: 600; color: var(--text-dim); margin-bottom: 10px; }
.param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.param-field span {
  display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 5px;
  font-family: var(--mono);
}
.match-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.match-hint { font-size: 11.5px; color: var(--text-faint); margin-top: 10px; line-height: 1.5; }

.quick-card { margin-top: 28px; }
.quick-title {
  font-size: 12px; color: var(--text-faint); margin-bottom: 10px;
  text-transform: uppercase; letter-spacing: 0.5px;
}
.quick-list { display: flex; flex-direction: column; gap: 6px; }
.quick-item {
  display: flex; justify-content: space-between; align-items: center;
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  cursor: pointer;
  color: var(--text);
  font-size: 13px;
  transition: all 0.12s;
}
.quick-item:hover { background: #f0f0f2; }
.q-name { font-family: var(--mono); font-size: 12.5px; }
.q-meta { color: var(--text-faint); font-size: 11.5px; }
</style>
