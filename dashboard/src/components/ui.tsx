import React from "react";
import { cn } from "@/lib/utils";

// ── Card ──
export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-center justify-between px-4 py-3 border-b", className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-sm font-semibold tracking-tight", className)} {...props}>
      {children}
    </h3>
  );
}

export function CardContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("p-4", className)} {...props}>
      {children}
    </div>
  );
}

// ── Badge ──
interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "danger" | "warning" | "outline";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const variants: Record<string, string> = {
    default: "bg-secondary text-secondary-foreground",
    success: "bg-green-500/20 text-green-400 border-green-500/30",
    danger: "bg-red-500/20 text-red-400 border-red-500/30",
    warning: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    outline: "border text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium border",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

// ── Button ──
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "outline" | "destructive";
  size?: "sm" | "md" | "lg" | "icon";
}

export function Button({ className, variant = "default", size = "md", ...props }: ButtonProps) {
  const variants: Record<string, string> = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    ghost: "hover:bg-accent hover:text-accent-foreground",
    outline: "border bg-transparent hover:bg-accent",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  };
  const sizes: Record<string, string> = {
    sm: "h-7 px-2 text-xs",
    md: "h-9 px-4 text-sm",
    lg: "h-11 px-6 text-base",
    icon: "h-8 w-8 p-0",
  };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

// ── Input ──
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-8 w-full rounded-md border bg-transparent px-3 py-1 text-xs shadow-sm transition-colors",
        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

// ── Stat display ──
interface StatProps {
  label: string;
  value: string | number;
  subtext?: string;
  className?: string;
}

export function Stat({ label, value, subtext, className }: StatProps) {
  return (
    <div className={cn("space-y-0.5", className)}>
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
    </div>
  );
}
