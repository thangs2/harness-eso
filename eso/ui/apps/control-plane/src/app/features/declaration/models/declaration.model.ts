export interface DeclarationItem {
    key: string;
    value: string;
    isCustomized: boolean;
}

export interface DeclarationPreview {
    hash: string;
    items: DeclarationItem[];
    impactSummary?: string;
}
