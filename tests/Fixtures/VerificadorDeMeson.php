<?php

namespace Muni\Arcop\Tests\Fixtures;

use Muni\Shared\Privacidad\Contratos\TitularDeDatos;
use Muni\Shared\Privacidad\Contratos\VerificadorIdentidad;
use Muni\Shared\Privacidad\ResultadoVerificacion;

/**
 * Verificador de mesón: la credencial presentada tiene que calzar con el
 * documento del titular.
 */
class VerificadorDeMeson implements VerificadorIdentidad
{
    public function verificar(array $contexto): ResultadoVerificacion
    {
        $titular = $contexto['titular'] ?? null;
        $credencial = trim((string) ($contexto['credencial'] ?? ''));

        if (! $titular instanceof TitularDeDatos || $credencial === '') {
            return ResultadoVerificacion::fallida('cedula_presencial', 'no se presentó credencial');
        }

        if ($credencial !== $titular->titularDocumento()) {
            return ResultadoVerificacion::fallida('cedula_presencial', 'la credencial no calza con el titular');
        }

        return new ResultadoVerificacion(true, 'cedula_presencial', [
            'funcionario_id' => $contexto['funcionario_id'] ?? null,
        ]);
    }
}
