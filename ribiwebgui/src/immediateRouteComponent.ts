import {
  defineAsyncComponent,
  defineComponent,
  h,
  type AsyncComponentLoader,
  type Component
} from "vue";

export const ROUTE_LOAD_TIMEOUT_MS = 12_000;

export type ImmediateRouteComponentOptions = {
  errorComponent?: Component;
  onLoadError?: (error: unknown) => void;
  onLoadSuccess?: () => void;
  timeoutMs?: number;
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
        options.onLoadError?.(error);
        throw error;
      }
    },
    loadingComponent,
    errorComponent: options.errorComponent,
    delay: 0,
    timeout: options.timeoutMs ?? ROUTE_LOAD_TIMEOUT_MS,
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
