<script setup>
defineProps({
  // Array of { dive_code, position, height, attempts, avg_score,
  // best_score }. From analytics.frequent_dives.
  data: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="card">
    <div class="card-head">Go-To Dives</div>
    <div v-if="!data?.length" class="empty-mini">No dives recorded yet.</div>
    <table v-else class="pb-table">
      <thead>
        <tr>
          <th>Dive</th>
          <th>Pos</th>
          <th>Height</th>
          <th>Attempts</th>
          <th>Avg</th>
          <th>Best</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="f in data" :key="f.dive_code + f.position + f.height">
          <td class="mono strong">{{ f.dive_code }}</td>
          <td class="mono">{{ f.position }}</td>
          <td class="mono">{{ f.height }}m</td>
          <td class="mono dim">{{ f.attempts }}</td>
          <td class="mono">{{ Number(f.avg_score).toFixed(1) }}</td>
          <td class="mono strong cyan">{{ Number(f.best_score).toFixed(1) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style src="./widget-shared.css"></style>
