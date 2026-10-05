/** "1 file", "3 files". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 files · +18 −3": uncommitted files, and the lines added and removed when there are any. */
export function ChangeCount({ files, insertions, deletions }: { files: number; insertions: number; deletions: number }) {
  return (
    <>
      {plural(files, "file")}
      {(insertions > 0 || deletions > 0) && (
        <>
          {" · "}
          <span className="add">+{insertions}</span> <span className="del">−{deletions}</span>
        </>
      )}
    </>
  );
}
