import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import { aliases, mdi } from "vuetify/iconsets/mdi";

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
      RabiLight: {
        dark: false,
        colors: {
          background: "#f6f8fb",
          surface: "#ffffff",
          primary: "#102a43",
          secondary: "#19bfc1",
          accent: "#ff6d9d",
          success: "#16a34a",
          warning: "#f59e0b",
          error: "#dc2626",
          info: "#087f91"
        }
      }
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
