export type PersonaOptionPresentation = {
  value?: string;
  label?: string;
  roleTitle?: string;
};

export type PersonaRoleInfoPresentation = {
  selectedRoleId?: string;
  selectedRoleTitle?: string;
  options?: PersonaOptionPresentation[];
};

export type PersonaGatewayPresentation = {
  id?: string;
  configName?: string;
  name?: string;
  routeName?: string;
  agentRoleId?: string;
};

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return "";
}

export function personaOptionDisplayName(option: PersonaOptionPresentation): string {
  return firstText(option.roleTitle, option.label, option.value);
}

export function gatewayPersonaDisplayName(
  gateway: PersonaGatewayPresentation,
  roleInfo?: PersonaRoleInfoPresentation
): string {
  const roleId = firstText(gateway.agentRoleId, roleInfo?.selectedRoleId);
  const selectedRole = roleInfo?.options?.find(option => firstText(option.value) === roleId);

  return firstText(
    selectedRole?.roleTitle,
    roleInfo?.selectedRoleTitle,
    gateway.routeName,
    gateway.name,
    selectedRole?.label,
    roleId,
    gateway.configName,
    gateway.id,
    "未命名人格"
  );
}

