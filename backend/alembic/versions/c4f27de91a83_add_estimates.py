"""add_estimates

Revision ID: c4f27de91a83
Revises: aed6229aa1a1
Create Date: 2026-08-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c4f27de91a83'
down_revision: Union[str, None] = 'aed6229aa1a1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('businesses', sa.Column('estimate_prefix', sa.String(), nullable=False, server_default='EST'))
    op.add_column('businesses', sa.Column('next_estimate_no', sa.Integer(), nullable=False, server_default='1'))

    op.create_table(
        'estimates',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('business_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('customer_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('number', sa.String(), nullable=False),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('currency', sa.String(), nullable=False),
        sa.Column('issue_date', sa.Date(), nullable=False),
        sa.Column('expiry_date', sa.Date(), nullable=True),
        sa.Column('discount_type', sa.String(), nullable=True),
        sa.Column('discount_value', sa.Integer(), nullable=False),
        sa.Column('subtotal_cents', sa.Integer(), nullable=False),
        sa.Column('tax_total_cents', sa.Integer(), nullable=False),
        sa.Column('discount_cents', sa.Integer(), nullable=False),
        sa.Column('total_cents', sa.Integer(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('terms', sa.Text(), nullable=True),
        sa.Column('converted_invoice_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('declined_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('converted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['customer_id'], ['customers.id']),
        sa.ForeignKeyConstraint(['converted_invoice_id'], ['invoices.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_estimates_business_id'), 'estimates', ['business_id'], unique=False)
    op.create_index(op.f('ix_estimates_customer_id'), 'estimates', ['customer_id'], unique=False)

    op.create_table(
        'estimate_line_items',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('estimate_id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('quantity', sa.Numeric(12, 4), nullable=False),
        sa.Column('unit_price_cents', sa.Integer(), nullable=False),
        sa.Column('tax_percent', sa.Numeric(5, 2), nullable=False),
        sa.ForeignKeyConstraint(['estimate_id'], ['estimates.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_estimate_line_items_estimate_id'), 'estimate_line_items', ['estimate_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_estimate_line_items_estimate_id'), table_name='estimate_line_items')
    op.drop_table('estimate_line_items')
    op.drop_index(op.f('ix_estimates_customer_id'), table_name='estimates')
    op.drop_index(op.f('ix_estimates_business_id'), table_name='estimates')
    op.drop_table('estimates')
    op.drop_column('businesses', 'next_estimate_no')
    op.drop_column('businesses', 'estimate_prefix')
