<script setup>
import { reactive, onMounted, ref } from 'vue';

const props = defineProps({ health: Object });
const emit = defineEmits(['close']);

const settings = reactive({
  headed: false,
  maxSteps: null,
  baseUrl: '',
  apiKey: '',
  model: '',
});
const saved = ref(false);

onMounted(() => {
  try {
    const raw = localStorage.getItem('pbagent-settings');
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch { /* 忽略 */ }
});

const save = () => {
  localStorage.setItem('pbagent-settings', JSON.stringify({ ...settings }));
  saved.value = true;
  setTimeout(() => { saved.value = false; emit('close'); }, 600);
};

const clearKey = () => {
  settings.apiKey = '';
  localStorage.setItem('pbagent-settings', JSON.stringify({ ...settings }));
};
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel">
      <div class="panel-head">
        <h2>设置</h2>
        <button class="close-btn" @click="emit('close')">×</button>
      </div>

      <div class="panel-body">
        <section class="section">
          <h3>默认模型（LLM）</h3>
          <p class="desc">
            留空使用服务端默认配置
            <template v-if="props.health?.llm?.configured">（{{ props.health.llm.model }}）</template>。
            Key 只保存在本地浏览器（localStorage），提交任务时随请求带给后端、内存中使用、不落服务端磁盘。
          </p>
          <label class="field">
            <span>Base URL（OpenAI 兼容）</span>
            <input class="input" v-model="settings.baseUrl" placeholder="https://api.example.com/v1" spellcheck="false" />
          </label>
          <div class="grid-2">
            <label class="field">
              <span>API Key</span>
              <input class="input" v-model="settings.apiKey" type="password" placeholder="sk-..." spellcheck="false" />
            </label>
            <label class="field">
              <span>模型名</span>
              <input class="input" v-model="settings.model" placeholder="qwen3.8-max / glm-5.2 / ..." spellcheck="false" />
            </label>
          </div>
          <button v-if="settings.apiKey" class="btn danger clear-key" @click="clearKey">清除已保存的 Key</button>
        </section>
      </div>

      <div class="panel-foot">
        <span v-if="saved" class="saved-tip">已保存</span>
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.panel {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  background: var(--bg-panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--hairline);
}
.panel-head h2 { font-size: 15px; font-weight: 700; }
.close-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 18px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.close-btn:hover { color: var(--text); background: var(--bg-hover); }

.panel-body { padding: 16px 18px; overflow-y: auto; }
.section { margin-bottom: 22px; }
.section:last-child { margin-bottom: 0; }
.section h3 {
  font-size: 12px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.desc { font-size: 12px; color: var(--text-faint); line-height: 1.6; margin-bottom: 12px; }

.field { display: block; margin-bottom: 12px; }
.field span {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 5px;
}
.field.inline {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field.inline input { width: 15px; height: 15px; cursor: pointer; }
.field.inline span { margin: 0; font-size: 13px; color: var(--text); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.narrow { width: 160px; }
.clear-key { margin-top: 2px; font-size: 12px; padding: 6px 12px; }

.panel-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--hairline);
}
.saved-tip { margin-right: auto; font-size: 12px; color: var(--ok); }
</style>
