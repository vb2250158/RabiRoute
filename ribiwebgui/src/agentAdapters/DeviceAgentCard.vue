<script setup lang="ts">
import type { AgentAdapterCardContext } from "./agentAdapterCardContext";
defineProps<{ context: AgentAdapterCardContext }>();
</script>
<template>
  <v-alert type="warning" variant="tonal" density="compact">
    实验设备 Agent：角色在设备设置中绑定，模型和语音由设备宿主提供。设备未完成加载时消息保留原投递身份等待，不会改投电脑模型。真机唤醒与执行需另行验收。
  </v-alert>
</template>
