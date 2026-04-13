import { type ReactNode, useEffect, useRef, useState } from "react";
import { IconChevronDown } from "./Icons";

export type SelectOption = {
  value: string;
  label: string;
};

type CustomSelectProps = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  icon?: ReactNode;
};

export function CustomSelect({ options, value, onChange, className, icon }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={`cselect${open ? " cselect--open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="cselect__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon && <span className="cselect__icon">{icon}</span>}
        <span className="cselect__value">{selected?.label ?? value}</span>
        <span className="cselect__chevron">
          <IconChevronDown size={14} />
        </span>
      </button>

      <div className="cselect__dropdown" role="listbox">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={opt.value === value}
            className={`cselect__option${opt.value === value ? " cselect__option--active" : ""}`}
            onClick={() => {
              onChange(opt.value);
              setOpen(false);
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
