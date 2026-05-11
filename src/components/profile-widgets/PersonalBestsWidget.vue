<script setup>
defineProps({
  // Array of { dive_code, position, height, dd, best_total,
  // attempts, event_name }. From profile.personal_bests.
  data: { type: Array, default: () => [] },
})
</script>

<template>
  <div class="card">
    <div class="card-head">Personal Bests by Dive</div>
    <div v-if="!data?.length" class="empty-mini">No dives recorded yet.</div>
    <table v-else class="pb-table">
      <thead>
        <tr>
          <th>Dive</th>
          <th>Pos</th>
          <th>Height</th>
          <th>DD</th>
          <th>Best</th>
          <th>Attempts</th>
          <th>At Meet</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="pb in data" :key="pb.dive_code + pb.position + pb.height">
          <td class="mono strong">{{ pb.dive_code }}</td>
          <td class="mono">{{ pb.position }}</td>
          <td class="mono">{{ pb.height }}m</td>
          <td class="mono cyan">{{ Number(pb.dd).toFixed(1) }}</td>
          <td class="mono strong">{{ Number(pb.best_total).toFixed(1) }}</td>
          <td class="mono dim">{{ pb.attempts }}</td>
          <td class="dim">{{ pb.event_name }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style src="./widget-shared.css"></style>
