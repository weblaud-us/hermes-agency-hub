"""Tenant container orchestration.

Deliberately re-exports nothing. Doing so made ``proxy/nginx.py``'s import of
``orchestrator.docker_service`` run this file, which pulled in ``provisioner``,
then ``proxy.service``, then ``proxy.nginx`` again while it was still half
initialised. Import from the submodules directly.
"""
