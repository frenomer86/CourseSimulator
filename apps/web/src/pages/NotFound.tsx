import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-2xl font-semibold">This page is not wired up.</h1>
      <p className="mt-2 text-ink-soft">The address does not match a course or lab.</p>
      <Link to="/" className="mt-6 inline-block rounded-md bg-high px-4 py-2 text-white font-medium">
        Back to the courses
      </Link>
    </div>
  );
}
