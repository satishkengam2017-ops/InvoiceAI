"""Async SQLAlchemy engine, session factory, and shared helpers."""
import os
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

# DATABASE_URL must be Supabase's DIRECT connection (port 5432), not the
# transaction-mode pooler (port 6543). SQLAlchemy's asyncpg dialect runs a
# JSON-codec setup query on every new connection using asyncpg's own
# internal, deterministic prepared-statement naming, which collides across
# pooled connections on PgBouncer's transaction mode
# (DuplicatePreparedStatementError) — verified directly, and no combination
# of NullPool/prepared_statement_name_func avoids it, since that setup step
# bypasses SQLAlchemy's overridable prepare path entirely. The transaction
# pooler exists to support many short-lived serverless connections; InvoiceAI
# is a single persistent server, which is exactly the case Supabase's own
# docs recommend the direct connection for instead.
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
