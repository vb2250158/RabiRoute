import {
  defineAsyncComponent,
  defineComponent,
  h,
  type AsyncComponentLoader,
  type Component
} from "vue";

export type ImmediateRouteComponentOptions = {
  onLoadError?: (error: unknown) => boolean;
  onLoadSuccess?: () => void;
};

export function createImmediateRouteComponent(
  loader: AsyncComponentLoader,
  loadingComponent: Component,
  options: ImmediateRouteComponentOptions = {}
): Component {
  const asyncPage = defineAsyncComponent({
    loader: async () => {
      try {
        const component = await loader();
        options.onLoadSuccess?.();
        return component;
      } catch (error) {
        if (options.onLoadError?.(error)) {
          return await new Promise<never>(() => undefined);
        }
        throw error;
      }
    },
    loadingComponent,
    delay: 0,
    suspensible: false
  });

  return defineComponent({
    name: "ImmediateRoutePage",
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h(asyncPage, attrs, slots);
    }
  });
}
