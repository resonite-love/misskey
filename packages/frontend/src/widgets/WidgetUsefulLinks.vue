<template>
  <div class="widget-useful-links">
    <h3>役立つリンク</h3>
    <ul>
      <li><a href="https://example.com" target="_blank" rel="noopener">Example サイト</a></li>
      <li><a href="https://misskey-hub.net/" target="_blank" rel="noopener">Misskey Hub</a></li>
      <li><a href="https://github.com/misskey-dev/misskey" target="_blank" rel="noopener">Misskey GitHub</a></li>
      <li><a href="https://docs.misskey-hub.net/" target="_blank" rel="noopener">Misskey ドキュメント</a></li>
    </ul>
  </div>
</template>

<script lang="ts" setup>
// 特にロジックなし（モックデータのみ）
</script>

<style scoped>
.widget-useful-links {
  padding: 8px;
}
.widget-useful-links h3 {
  margin-bottom: 8px;
  font-size: 1.1em;
}
.widget-useful-links ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.widget-useful-links li {
  margin-bottom: 6px;
}
.widget-useful-links a {
  color: #3498db;
  text-decoration: underline;
}
</style>
