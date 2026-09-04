import type { ButtonHTMLAttributes } from "react";

import "./Button.css";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost";
}

export function Button({ variant = "default", className, ...rest }: ButtonProps) {
  const cls = ["ui-btn", variant === "primary" ? "ui-btn-primary" : "", variant === "ghost" ? "ui-btn-ghost" : "", className]
    .filter(Boolean)
    .join(" ");
  return <button className={cls} {...rest} />;
}
