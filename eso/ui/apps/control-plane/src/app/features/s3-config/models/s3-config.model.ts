export interface S3ConfigItem {
    key: string;
    value: string;
    isCustomized: boolean;
}

export interface S3ConfigPreview {
    hash: string;
    items: S3ConfigItem[];
    impactSummary?: string;
}
