"""add_gst_hst_number

Revision ID: 4cd3abf46add
Revises: 8f9241962755
Create Date: 2026-07-25 09:43:37.004303

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4cd3abf46add'
down_revision: Union[str, None] = '8f9241962755'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('businesses', sa.Column('gst_hst_number', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('businesses', 'gst_hst_number')
