export interface RiskItem {
    id: string;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    source: string;
}
