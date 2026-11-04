import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';

@Component({
    selector: 'eso-button',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <button
            [type]="type()"
            [disabled]="disabled()"
            [class]="buttonClass()"
            (click)="clicked.emit($event)"
        >
            <ng-content></ng-content>
        </button>
    `,
})
export class ButtonComponent {
    readonly type = input<'button' | 'submit' | 'reset'>('button');
    readonly disabled = input<boolean>(false);
    readonly variant = input<'primary' | 'secondary' | 'danger'>('primary');

    readonly clicked = output<MouseEvent>();

    buttonClass(): string {
        return `btn btn-${this.variant()}`;
    }
}
