export type RouteLoadLocation = {
  reload: () => void;
};

export function retryRouteLoad(location: RouteLoadLocation = window.location): void {
  location.reload();
}
