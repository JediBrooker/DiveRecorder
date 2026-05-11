<script setup>
defineProps({
  // { gold, silver, bronze, finalist, further }. From
  // analytics.placings. May be null while analytics is loading.
  data: { type: Object, default: null },
})
</script>

<template>
  <div class="card">
    <div class="card-head">Medals &amp; Placings</div>
    <div v-if="!data" class="empty-mini">Loading…</div>
    <div v-else class="placings-row">
      <div class="placing-cell place-gold">
        <div class="placing-num">{{ data.gold }}</div>
        <div class="placing-lbl">🥇 Gold</div>
      </div>
      <div class="placing-cell place-silver">
        <div class="placing-num">{{ data.silver }}</div>
        <div class="placing-lbl">🥈 Silver</div>
      </div>
      <div class="placing-cell place-bronze">
        <div class="placing-num">{{ data.bronze }}</div>
        <div class="placing-lbl">🥉 Bronze</div>
      </div>
      <div class="placing-cell">
        <div class="placing-num">{{ data.finalist }}</div>
        <div class="placing-lbl">Finalist (4–8)</div>
      </div>
      <div class="placing-cell">
        <div class="placing-num">{{ data.further }}</div>
        <div class="placing-lbl">9th+</div>
      </div>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.placings-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.6rem;
}
.placing-cell {
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0.7rem 0.875rem;
  text-align: center;
}
.placing-cell.place-gold   { border-color: rgba(234,179,8,0.4);  background: rgba(234,179,8,0.06);  }
.placing-cell.place-silver { border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.placing-cell.place-bronze { border-color: rgba(180,83,9,0.4);   background: rgba(180,83,9,0.06);   }
.placing-num {
  font-family: var(--font-display); font-size: 28px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.placing-cell.place-gold   .placing-num { color: #f59e0b; }
.placing-cell.place-silver .placing-num { color: #94a3b8; }
.placing-cell.place-bronze .placing-num { color: #b45309; }
.placing-lbl {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.4rem;
}
@media print {
  .placing-num { color: #000 !important; }
  .placing-lbl { color: #555 !important; }
}
</style>
