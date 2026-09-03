export type XiaomiHomeCredentialSource = "protected" | "none";

export type XiaomiHomeAuthorizationState =
  | "authorization_required"
  | "ready"
  | "authorization_failed"
  | "unreachable"
  | "timeout";

export type XiaomiHomeAuthorizationSnapshot = Readonly<{
  schemaVersion: 1;
  state: XiaomiHomeAuthorizationState;
  configured: boolean;
  credentialSource: XiaomiHomeCredentialSource;
  removable: boolean;
  baseUrl: string;
  endpointAccountId?: string;
  providerName?: string;
  providerVersion?: string;
  verifiedAt?: string;
  updatedAt?: string;
  errorCode?: string;
  revision: string;
}>;

export type XiaomiHomeAuthorizeRequest = Readonly<{
  accessToken: string;
  baseUrl: string;
  settingsRevision: string;
  authorizationRevision: string;
}>;

export type XiaomiHomeAuthorizationMutationRequest = Readonly<{
  authorizationRevision: string;
}>;
