"""add_vendors_expense_categories_expenses

Revision ID: b91e6a2f0c14
Revises: 747fdfb9d8e2
Create Date: 2026-08-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b91e6a2f0c14'
down_revision: Union[str, None] = '747fdfb9d8e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'vendors',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('email', sa.String(), nullable=True),
        sa.Column('phone', sa.String(), nullable=True),
        sa.Column('address_line1', sa.String(), nullable=True),
        sa.Column('city', sa.String(), nullable=True),
        sa.Column('region', sa.String(), nullable=True),
        sa.Column('postal_code', sa.String(), nullable=True),
        sa.Column('country', sa.String(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('archived', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_vendors_business_id'), 'vendors', ['business_id'], unique=False)

    op.create_table(
        'expense_categories',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('cra_t2125_line', sa.String(), nullable=True),
        sa.Column('is_default', sa.Boolean(), nullable=False),
        sa.Column('archived', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_expense_categories_business_id'), 'expense_categories', ['business_id'], unique=False)

    op.create_table(
        'expenses',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('vendor_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('category_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('amount_cents', sa.Integer(), nullable=False),
        sa.Column('tax_cents', sa.Integer(), nullable=False),
        sa.Column('currency', sa.String(), nullable=False),
        sa.Column('payment_method', sa.String(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['vendor_id'], ['vendors.id']),
        sa.ForeignKeyConstraint(['category_id'], ['expense_categories.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_expenses_business_id'), 'expenses', ['business_id'], unique=False)
    op.create_index(op.f('ix_expenses_vendor_id'), 'expenses', ['vendor_id'], unique=False)
    op.create_index(op.f('ix_expenses_category_id'), 'expenses', ['category_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_expenses_category_id'), table_name='expenses')
    op.drop_index(op.f('ix_expenses_vendor_id'), table_name='expenses')
    op.drop_index(op.f('ix_expenses_business_id'), table_name='expenses')
    op.drop_table('expenses')
    op.drop_index(op.f('ix_expense_categories_business_id'), table_name='expense_categories')
    op.drop_table('expense_categories')
    op.drop_index(op.f('ix_vendors_business_id'), table_name='vendors')
    op.drop_table('vendors')
