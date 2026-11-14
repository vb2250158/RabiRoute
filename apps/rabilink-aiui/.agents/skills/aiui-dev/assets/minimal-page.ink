<script def>
{
  "navigationBarTitleText": "AIUI"
}
</script>

<script setup>
export default {
  data: {
    message: 'Hello AIUI',
  },
};
</script>

<page>
  <view class="page">
    <text>{{message}}</text>
  </view>
</page>

<style>
.page {
  width: 100%;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-md);
  color: var(--color-text-primary);
  background: var(--color-background);
}
</style>
