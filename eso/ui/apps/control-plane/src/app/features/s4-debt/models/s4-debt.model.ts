export interface S4DebtItem {
    id: string;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    source: string;
}
