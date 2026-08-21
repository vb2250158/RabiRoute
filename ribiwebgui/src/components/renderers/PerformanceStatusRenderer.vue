<script setup lang="ts">
type PerformanceStatusContext = Readonly<{
  onlineSources: number;
  totalSources: number;
  managerCpuPercent: number;
  latestRequestP95: number;
  totalDiskMb: number;
  logDirectory: string;
}>;

defineProps<{ context: PerformanceStatusContext }>();
</script>

<template>
  <section class="performance-grid performance-overview">
    <article class="performance-stat primary">
      <span>在线采集器</span>
      <strong>{{ context.onlineSources }}<small>/{{ context.totalSources }}</small></strong>
      <p>Manager、Gateway 与已打开的 WebGUI</p>
    </article>
    <article class="performance-stat">
      <span>Manager CPU</span>
      <strong>{{ context.managerCpuPercent.toFixed(1) }}<small>%</small></strong>
      <p>100% 表示占满一个逻辑核心</p>
    </article>
    <article class="performance-stat">
      <span>请求 P95</span>
      <strong>{{ context.latestRequestP95.toFixed(1) }}<small>ms</small></strong>
      <p>最近采样区间内的接口耗时</p>
    </article>
    <article class="performance-stat">
      <span>性能日志</span>
      <strong>{{ context.totalDiskMb.toFixed(1) }}<small>MB</small></strong>
      <p>{{ context.logDirectory }}</p>
    </article>
  </section>
</template>

<style scoped>
.performance-grid { display: grid; gap: 16px; }
.performance-overview { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.performance-stat { min-width: 0; border: 1px solid rgba(15, 139, 141, .18); border-radius: 22px; padding: 22px; background: var(--surface-card); box-shadow: var(--shadow-card); }
.performance-stat.primary { background: linear-gradient(145deg, #0f8b8d, #0b6e76); color: white; }
.performance-stat span { color: var(--text-muted); font-size: 12px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
.performance-stat.primary span, .performance-stat.primary p { color: rgba(255, 255, 255, .76); }
.performance-stat strong { display: block; margin: 8px 0 3px; font-size: 32px; line-height: 1; }
.performance-stat small { margin-left: 4px; font-size: 14px; }
.performance-stat p { margin: 0; overflow: hidden; color: var(--text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1100px) { .performance-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) { .performance-overview { grid-template-columns: 1fr; } }
</style>
