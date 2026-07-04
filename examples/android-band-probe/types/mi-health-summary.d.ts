export type MiHealthStatus =
  | "available"
  | "empty"
  | "blocked"
  | "expected-blocked"
  | "skipped"
  | "probe-required"
  | "composite";

export interface MiHealthSummary {
  source: "mi-health/summary";
  status: "composite";
  heartRate: MiHealthHeartRateSummary;
  sleep: MiHealthSleepSummary;
  healthConnect: MiHealthConnectSummary;
  provider: MiHealthProviderSummary;
}

export interface MiHealthHeartRateSummary {
  latest: {
    status: MiHealthStatus;
    bpm: number | null;
    localTime: string | null;
  };
  availableApis: string[];
  blockedApis: string[];
  reason: string;
}

export interface MiHealthSleepSummary {
  providerPaths: string[];
  scheduleStatus: MiHealthStatus;
  schedule: Record<string, string | number | boolean | null> | null;
  configStatus: MiHealthStatus;
  config: Record<string, string | number | boolean | null> | null;
  reportSearchStatus: MiHealthStatus;
  searchedDaysBack: number;
  availableDays: MiHealthSleepAvailableDay[];
  reason: string;
}

export interface MiHealthSleepAvailableDay {
  date: string;
  reportStatus: MiHealthStatus;
  stagesStatus: MiHealthStatus;
  [key: string]: unknown;
}

export interface MiHealthConnectSummary {
  status: MiHealthStatus;
  heartRateSampleCount: number | null;
  sleepRecordCount: number | null;
  stepsRecordCount: number | null;
  reason: string;
}

export interface MiHealthProviderSummary {
  categoryScanStatus: MiHealthStatus;
  categoryScanReason: string | null;
  availableCategories: string[];
  blockedCategories: string[];
  healthProviderServiceStatus: MiHealthStatus;
  healthProviderServiceReason: string;
}
