/** Shared presentational components. */

import type { ReactNode } from 'react';
import type { JobStatus, PromptStatus } from '@h3/shared';

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="muted">{label}</span> : null}
    </span>
  );
}

export function CenterState({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="center-state">
      <div className="icon" aria-hidden="true">
        {icon}
      </div>
      <h2>{title}</h2>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message, code }: { message: string; code?: string }) {
  return (
    <div className="error-banner" role="alert">
      <div>{message}</div>
      {code ? <div className="code">{code}</div> : null}
    </div>
  );
}

export function Badge({
  status,
  pulse,
}: {
  status: JobStatus | PromptStatus;
  pulse?: boolean;
}) {
  const cls = pulse ? `badge ${status} dot` : `badge ${status}`;
  return <span className={cls}>{status}</span>;
}

export function Tag({ name }: { name: string }) {
  return <span className="tag">#{name}</span>;
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
