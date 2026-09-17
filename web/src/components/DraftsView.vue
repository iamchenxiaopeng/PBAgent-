<script setup>
import { ref, onMounted } from 'vue';

const emit = defineEmits(['open-home']);

const items = ref([]);
const loading = ref(true);
const error = ref('');
/** 当前选中的流程明细（null = 未选） */
const current = ref(null);
const detailLoading = ref(false);
const showYaml = ref(false);
/** 待确认删除的流程名（二次确认，删除不可恢复） */
const pendingDelete = ref(null);
const deleting = ref(false);

const load = async () => {
  loading.value = true;
  error.value = '';
  try {
    const r = await fetch('/api/drafts');
    const d = await r.json();
    items.value = d.items ?? [];
  } catch (e) {
    error.value = `加载失败：${e.message}`;
  } finally {
    loading.value = false;
  }
};

const open = async (it) => {
  if (current.value?.name === it.name) return;
  detailLoading.value = true;
  showYaml.value = false;
  pendingDelete.value = null;
  try {
    const r = await fetch(`/api/drafts/${encodeURIComponent(it.name)}`);
    if (!r.ok) throw new Error((await r.json()).error || `读取失败（${r.status}）`);
    current.value = await r.json();
  } catch (e) {
    current.value = null;
    error.value = e.message;
  } finally {
    detailLoading.value = false;
  }
};

const confirmDelete = (name) => {
  pendingDelete.value = pendingDelete.value === name ? null : name;
};

const doDelete = async () => {
  const name = pendingDelete.value;
  if (!name) return;
  deleting.value = true;
  try {
    const r = await fetch(`/api/drafts/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `删除失败（${r.status}）`);
    items.value = items.value.filter((x) => x.name !== name);
    current.value = null;
    pendingDelete.value = null;
  } catch (e) {
    error.value = e.message;
  } finally {
    deleting.value = false;
  }
};

const hostOf = (it) => {
  if (it.baseUrl) return it.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return it.allowDomains?.[0] ?? '—';
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const fmtVersionDate = (s) => (s ? fmtDate(s).slice(5) : '—');

onMounted(load);
</script>

<template>
  <div class="drafts">
    <header class="d-head">
      <div>
        <h1>沉淀库</h1>
        <p class="sub">Agent 跑通后蒸馏出的 Playbook——命中即零 LLM 执行</p>
      </div>
      <button class="btn" @click="load">刷新</button>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="d-body">
      <div class="list">
        <div v-if="loading" class="hint">加载中…</div>
        <div v-else-if="!items.length" class="hint">
          还没有沉淀流程。跑任务时把「沉淀」档位切到「成功即沉淀」，Agent 成功后会自动生成一条。
        </div>
        <div
          v-for="it in items"
          :key="it.name"
          class="item"
          :class="{ active: current?.name === it.name }"
          @click="open(it)"
        >
          <div class="i-top">
            <span class="i-name">{{ it.name }}</span>
            <span v-if="it.origin === 'auto'" class="tag">自动</span>
            <span v-if="!it.valid" class="tag bad">校验失败</span>
          </div>
          <div class="i-desc">{{ it.description || '（无描述）' }}</div>
          <div class="i-meta">
            {{ hostOf(it) }} · {{ it.stepCount }} 步 · v{{ it.currentVersion }}
            <template v-if="it.versionCount"> · {{ it.versionCount }} 版本</template>
          </div>
          <div class="i-time">{{ fmtDate(it.updatedAt) }}</div>
        </div>
      </div>

      <div class="detail">
        <div v-if="detailLoading" class="hint">加载明细…</div>

        <div v-else-if="!current" class="empty">
          <p>点击左侧任意一条查看明细</p>
          <p class="dim">明细包含：目标站点、参数、完整步骤与 YAML 源码</p>
        </div>

        <div v-else class="d-content">
          <div class="d-title">
            <div>
              <div class="dt-name">{{ current.name }}</div>
              <div class="dt-desc">{{ current.description || '（无描述）' }}</div>
            </div>
            <button class="btn danger" @click="confirmDelete(current.name)">删除</button>
          </div>

          <div v-if="pendingDelete === current.name" class="confirm">
            <span>
              确认删除《{{ current.name }}》？
              <template v-if="current.versionCount">
                连同 {{ current.versionCount }} 个历史版本一并删除，
              </template>
              不可恢复。
            </span>
            <button class="btn danger" :disabled="deleting" @click="doDelete">确认删除</button>
            <button class="btn" @click="pendingDelete = null">取消</button>
          </div>

          <div class="grid">
            <div class="cell">
              <span class="k">目标站点</span>
              <span class="v mono">{{ current.baseUrl || '—' }}</span>
            </div>
            <div class="cell">
              <span class="k">允许域名</span>
              <span class="v mono">{{ current.allowDomains?.length ? current.allowDomains.join('、') : '—' }}</span>
            </div>
            <div class="cell">
              <span class="k">参数</span>
              <span class="v mono">{{ current.params?.length ? current.params.join('、') : '无' }}</span>
            </div>
            <div class="cell">
              <span class="k">来源</span>
              <span class="v">{{ current.origin === 'auto' ? 'Agent 轨迹自动沉淀' : '手写 / 人工维护' }}</span>
            </div>
            <div class="cell">
              <span class="k">更新时间</span>
              <span class="v">{{ fmtDate(current.updatedAt) }}</span>
            </div>
            <div class="cell">
              <span class="k">校验</span>
              <span class="v" :class="{ bad: !current.valid }">
                {{ current.valid ? '通过（可直接执行）' : `失败：${current.error}` }}
              </span>
            </div>
          </div>

          <div v-if="current.versions?.length" class="versions">
            <div class="sec-title">版本链</div>
            <div v-for="v in current.versions" :key="v.v" class="v-row">
              <span class="v-badge">v{{ v.v }}</span>
              <span class="v-reason">{{ v.reason }}</span>
              <span v-if="v.isCurrent" class="v-cur">当前</span>
              <span v-else-if="!v.everPromoted" class="v-draft">草稿</span>
              <span class="v-date">{{ fmtVersionDate(v.date) }}</span>
            </div>
          </div>

          <div class="steps">
            <div class="sec-title">步骤（{{ current.steps.length }}）</div>
            <div v-for="s in current.steps" :key="s.index" class="step">
              <span class="s-idx">{{ s.index }}</span>
              <div class="s-main">
                <div class="s-line">
                  <span class="s-act">{{ s.action }}</span>
                  <span class="s-name">{{ s.name }}</span>
                </div>
                <div v-if="s.url" class="s-detail mono">url: {{ s.url }}</div>
                <div v-if="s.selector" class="s-detail mono">selector: {{ s.selector }}</div>
                <div v-if="s.value !== undefined" class="s-detail mono">value: {{ s.value }}</div>
                <div v-if="s.extra" class="s-detail mono">{{ s.extra }}</div>
              </div>
            </div>
          </div>

          <div class="yaml-box">
            <button class="yaml-toggle" @click="showYaml = !showYaml">
              {{ showYaml ? '收起 YAML' : '查看 YAML 源码' }}
            </button>
            <pre v-if="showYaml" class="yaml mono">{{ current.yaml }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drafts {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  padding: 24px 24px 0;
}

.d-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-shrink: 0;
  margin-bottom: 18px;
}
.d-head h1 { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; }
.sub { color: var(--text-dim); font-size: 12.5px; margin-top: 4px; }

.error { color: var(--err); font-size: 12.5px; margin-bottom: 10px; }

.d-body {
  flex: 1;
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 24px;
  min-height: 0;
  padding-bottom: 24px;
}

.list { overflow-y: auto; padding-right: 4px; }
.hint { color: var(--text-faint); font-size: 12.5px; line-height: 1.7; }

.item {
  position: relative;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 4px;
  transition: background 0.1s;
}
.item:hover { background: var(--bg-hover); }
.item.active { background: var(--bg-panel); }

.i-top { display: flex; align-items: center; gap: 6px; }
.i-name {
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item.active .i-name { font-weight: 700; }
.tag {
  font-size: 10.5px;
  color: var(--text-dim);
  background: var(--bg-elevated);
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.tag.bad { color: var(--err); background: rgba(179, 57, 46, 0.08); }
.i-desc {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.i-meta { font-size: 11px; color: var(--text-faint); margin-top: 4px; }
.i-time { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }

.detail { overflow-y: auto; padding-right: 4px; }
.empty { color: var(--text-faint); font-size: 13px; padding: 60px 0; }
.empty .dim { font-size: 12px; margin-top: 8px; }

.d-title {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 14px;
}
.dt-name { font-family: var(--mono); font-size: 15px; font-weight: 700; }
.dt-desc { color: var(--text-dim); font-size: 12.5px; margin-top: 4px; }

.confirm {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: rgba(179, 57, 46, 0.06);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 12.5px;
  color: var(--text);
  margin-bottom: 16px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}
.cell { background: var(--bg-sidebar); border-radius: var(--radius-sm); padding: 10px 12px; }
.k { display: block; font-size: 11px; color: var(--text-faint); margin-bottom: 4px; }
.v { font-size: 12.5px; color: var(--text); word-break: break-all; }
.v.bad { color: var(--err); }
.mono { font-family: var(--mono); }

.sec-title {
  font-size: 11.5px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.versions { margin-bottom: 22px; }
.v-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  padding: 6px 0;
}
.v-badge { font-family: var(--mono); font-size: 11.5px; color: var(--text); width: 32px; }
.v-reason { flex: 1; color: var(--text-dim); }
.v-cur, .v-draft { font-size: 10.5px; color: var(--text-dim); background: var(--bg-elevated); padding: 1px 6px; border-radius: 999px; }
.v-date { font-size: 11px; color: var(--text-faint); }

.steps { margin-bottom: 22px; }
.step {
  display: flex;
  gap: 12px;
  padding: 10px 0;
}
.s-idx {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  width: 20px;
  flex-shrink: 0;
  padding-top: 2px;
}
.s-main { min-width: 0; }
.s-line { display: flex; align-items: center; gap: 8px; }
.s-act {
  font-family: var(--mono);
  font-size: 10.5px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  padding: 1px 7px;
  border-radius: 999px;
  flex-shrink: 0;
}
.s-name { font-size: 13px; color: var(--text); }
.s-detail { font-size: 11.5px; color: var(--text-faint); margin-top: 3px; word-break: break-all; }

.yaml-box { padding-bottom: 24px; }
.yaml-toggle {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  cursor: pointer;
  padding: 0;
}
.yaml-toggle:hover { color: var(--text); }
.yaml {
  margin-top: 10px;
  background: var(--bg-sidebar);
  border-radius: var(--radius-sm);
  padding: 14px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
