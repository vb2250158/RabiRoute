import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { aliases, mdi } from "vuetify/iconsets/mdi";
import { RABI_DARK_THEME } from "../themes/dark/vuetify";
import { RABI_LIGHT_THEME } from "../themes/light/vuetify";

export const vuetify = createVuetify({
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
      RabiDark: RABI_DARK_THEME
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
