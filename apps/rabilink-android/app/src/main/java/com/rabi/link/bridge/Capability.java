package com.rabi.link.bridge;

public final class Capability {
    private final String id;
    private final String displayName;
    private final String category;
    private final boolean requiresUserAction;
    private final boolean requiresExternalApp;
    private final String description;

    public Capability(
            String id,
            String displayName,
            String category,
            boolean requiresUserAction,
            boolean requiresExternalApp,
            String description
    ) {
        this.id = id;
        this.displayName = displayName;
        this.category = category;
        this.requiresUserAction = requiresUserAction;
        this.requiresExternalApp = requiresExternalApp;
        this.description = description;
    }

    public String id() {
        return id;
    }

    public String displayName() {
        return displayName;
    }

    public String category() {
        return category;
    }

    public boolean requiresUserAction() {
        return requiresUserAction;
    }

    public boolean requiresExternalApp() {
        return requiresExternalApp;
    }

    public String description() {
        return description;
    }
}
