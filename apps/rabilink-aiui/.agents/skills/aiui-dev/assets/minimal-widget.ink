<script def>
{
  "widget": { "family": "1x1" }
}
</script>

<script setup>
export default {
  data: {
    message: 'Hello AIUI',
  },

  onCreate(options) {},

  onAttach() {},

  onDetach() {},

  onDestroy() {},
};
</script>

<widget>
  <view class="widget">
    <text>{{message}}</text>
  </view>
</widget>

<style>
.widget {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-md);
  color: var(--color-text-primary);
  background: var(--color-background);
}
</style>
