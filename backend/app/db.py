"""Async SQLAlchemy engine, session factory, and shared helpers."""
import os
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

# DATABASE_URL must be Supabase's SESSION-mode pooler (port 5432,
# *.pooler.supabase.com), not the TRANSACTION-mode pooler (port 6543, same
# host). This is still Supavisor (Supabase's pooler), not a true unpooled
# direct connection (db.<project-ref>.supabase.co) — that genuine direct
# endpoint needs IPv6 reachability, which isn't confirmed for this app's
# eventual deployment target, so it's deliberately not used here.
#
# SQLAlchemy's asyncpg dialect runs a JSON-codec setup query on every new
# connection using asyncpg's own internal, deterministic prepared-statement
# naming. Under transaction-mode pooling, the physical Postgres backend
# connection can be reassigned between statements, so that name collides
# with another session's prepared statement of the same name
# (DuplicatePreparedStatementError) — verified directly, and no combination
# of NullPool/prepared_statement_name_func avoids it, since the codec setup
# bypasses SQLAlchemy's overridable prepare path entirely. Session mode
# holds one dedicated backend connection for the lifetime of the client
# session, which avoids the reassignment that causes the collision.
DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


def to_dict(obj) -> dict:
    """Convert a SQLAlchemy ORM instance to a plain dict of its own columns
    (no relationships) — the Postgres equivalent of the old clean() helper
    that stripped MongoDB's _id. Used throughout the routers to build JSON
    responses exactly like the dict-based Mongo documents did.
    """
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
