import { ReactNode } from "react";

export type OptionPillOption = {
  value: string;
  label: ReactNode;
};

type SingleProps = {
  options: OptionPillOption[];
  value: string;
  onChange: (value: string) => void;
  multi?: false;
  disabled?: boolean;
  allowDeselect?: boolean;
  className?: string;
  testIdPrefix?: string;
};

type MultiProps = {
  options: OptionPillOption[];
  value: string[];
  onChange: (value: string[]) => void;
  multi: true;
  disabled?: boolean;
  className?: string;
  testIdPrefix?: string;
};

type OptionPillsProps = SingleProps | MultiProps;

export function OptionPills(props: OptionPillsProps) {
  const { options, disabled, className, testIdPrefix } = props;

  const isSelected = (val: string) => {
    if (props.multi) return props.value.includes(val);
    return props.value === val;
  };

  const handleClick = (val: string) => {
    if (disabled) return;
    if (props.multi) {
      const next = props.value.includes(val)
        ? props.value.filter((v) => v !== val)
        : [...props.value, val];
      props.onChange(next);
    } else {
      if (props.allowDeselect && props.value === val) {
        props.onChange("");
      } else {
        props.onChange(val);
      }
    }
  };

  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {options.map((opt) => {
        const selected = isSelected(opt.value);
        const slug = opt.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleClick(opt.value)}
            disabled={disabled}
            data-testid={testIdPrefix ? `${testIdPrefix}-${slug}` : undefined}
            className={`px-3 py-1.5 rounded-full text-sm border font-ui transition-colors ${
              selected
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-border"
            } ${
              disabled
                ? selected
                  ? "cursor-default"
                  : "opacity-50 cursor-default"
                : selected
                ? "hover:bg-primary/90"
                : "hover:border-primary/50 hover:bg-secondary/40"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
