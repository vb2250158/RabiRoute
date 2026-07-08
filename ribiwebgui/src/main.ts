import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import "./styles.css";

import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { installManagerFetchPrefix } from "./managerApi";
import { router } from "./router";
import { vuetify } from "./plugins/vuetify";

installManagerFetchPrefix();

createApp(App)
  .use(createPinia())
  .use(router)
  .use(vuetify)
  .mount("#app");
