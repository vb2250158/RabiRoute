import "@mdi/font/css/materialdesignicons.css";
import "vuetify/styles";
import "./styles.css";

import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { installDomLocalizer } from "./i18n/domLocalizer";
import { createLazyRouteRecovery } from "./lazyRouteRecovery";
import { installManagerFetchPrefix } from "./managerApi";
import { router } from "./router";
import { vuetify } from "./plugins/vuetify";
import { redirectLoopbackWebguiToLan } from "./webguiLanRedirect";

const lazyRouteRecovery = createLazyRouteRecovery();
router.onError((error, target) => {
  lazyRouteRecovery.recover(error, target.fullPath);
});

async function bootstrap(): Promise<void> {
  installManagerFetchPrefix();
  if (await redirectLoopbackWebguiToLan()) return;

  createApp(App)
    .use(createPinia())
    .use(router)
    .use(vuetify)
    .mount("#app");

  installDomLocalizer();
  void router.isReady().then(() => lazyRouteRecovery.markReady()).catch(() => undefined);
}

void bootstrap();
