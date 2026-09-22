"""
Shared exception types for per-service clients (sonarr_client.py and
whatever follows it). Keeping these in one place means the dispatch in
app/api/services.py catches one pair of exception types regardless of which
service type the request was for, instead of growing an except clause per
client module as Radarr/Seerr/etc. are added.
"""
from __future__ import annotations


class ConnectivityError(Exception):
    """Raised when the upstream service can't be reached or the API key is
    rejected — kept distinct from the service reaching fine and reporting
    its own issues (scope #8)."""


class ServiceApiError(Exception):
    """Raised when the upstream service is reachable but returned an
    unexpected response for a detail-view call."""
