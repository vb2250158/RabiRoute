import { createVuetify } from "vuetify";
import { watch } from "vue";
import { en, ja, zhHans } from "vuetify/locale";
import { useI18n } from "../i18n";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { aliases, mdi } from "vuetify/iconsets/mdi";
import { RABI_DARK_THEME } from "../themes/dark/vuetify";
import { RABI_LIGHT_THEME } from "../themes/light/vuetify";

export const vuetify = createVuetify({
  locale: { locale: "zhHans", fallback: "en", messages: { en, ja, zhHans } },
  components,
  directives,
  icons: {
    defaultSet: "mdi",
    aliases,
    sets: {
      mdi
    }
  },
  theme: {
    defaultTheme: "RabiLight",
    themes: {
      RabiLight: RABI_LIGHT_THEME,
      RabiDark: RABI_DARK_THEME,
      RabiCustom: RABI_LIGHT_THEME
    }
  },
  defaults: {
    VBtn: {
      rounded: "lg",
      textTransform: "none"
    },
    VCard: {
      rounded: "lg"
    },
    VTextField: {
      variant: "outlined",
      density: "comfortable",
      hideDetails: "auto"
    },
    VSelect: {
      variant: "outlined",
      density: "comfortable",
      hideDetails: "auto"
    },
    VTextarea: {
      variant: "outlined",
      density: "comfortable",
      hideDetails: "auto"
    }
  }
});

watch(useI18n().locale, locale => {
  vuetify.locale.current.value = locale === "zh-CN" ? "zhHans" : locale;
}, { immediate: true });
