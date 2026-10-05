import React, { useEffect, useState } from "react";
import { isErr, type RepoEntry } from "../shared/types";
import { Pick } from "./Menu";

/** The git repositories under the configured folders, read once; `error` says why they couldn't be. */
export function useRepos(): { repos: RepoEntry[]; error: string } {
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    window.mb.listRepos().then(
      (r: RepoEntry[] | { error: string }) => live && (isErr(r) ? setError(r.error) : setRepos(r)),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err))
    );
    return () => {
      live = false;
    };
  }, []);
  return { repos, error };
}

/**
 * A repository dropdown: `none` first, then the repositories found, and the
 * current one even when it isn't among them. When the list couldn't be read,
 * it says so under the dropdown.
 */
export function RepoPick({ value, onChange, none, className, title }: { value: string; onChange: (path: string) => void; none: string; className?: string; title?: string }) {
  const { repos, error } = useRepos();
  return (
    <>
      <Pick className={className} value={value} title={title} onChange={(e) => onChange(e.target.value)}>
        <option value="">{none}</option>
        {value && !repos.some((r) => r.path === value) && <option value={value}>{value.split("/").pop()}</option>}
        {repos.map((r) => (
          <option key={r.path} value={r.path}>
            {r.name}
          </option>
        ))}
      </Pick>
      {error && <div className="err">Couldn't list repos: {error}</div>}
    </>
  );
}
