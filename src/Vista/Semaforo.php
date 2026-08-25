<?php

namespace Muni\Arcop\Vista;

use Muni\Shared\Privacidad\Ciclo\EstadoDePlazo;
use Muni\Shared\Privacidad\EstadoDeSolicitud;

/**
 * La ÚNICA traducción de estado a CSS que hace este paquete.
 *
 * El estado lo decide el módulo (`PlazoLegal`); acá solo se elige la clase. Y la
 * etiqueta siempre se muestra junto al color: el color no puede ser el único
 * portador de información (WCAG 2.2, y el Decreto N°1/2015 lo hace obligatorio
 * para un sistema del Estado).
 */
final class Semaforo
{
    public static function clasePlazo(EstadoDePlazo $estado): string
    {
        return 'arcop-marca arcop-marca--'.match ($estado) {
            EstadoDePlazo::Resuelta => 'neutra',
            EstadoDePlazo::Vencida => 'grave',
            EstadoDePlazo::PorVencer => 'aviso',
            EstadoDePlazo::EnPlazo => 'bien',
        };
    }

    public static function claseEstado(EstadoDeSolicitud $estado): string
    {
        return 'arcop-marca arcop-marca--'.match ($estado) {
            EstadoDeSolicitud::Recibida => 'aviso',
            EstadoDeSolicitud::EnTramite => 'info',
            EstadoDeSolicitud::Acogida, EstadoDeSolicitud::AcogidaParcial => 'bien',
            EstadoDeSolicitud::Rechazada => 'neutra',
        };
    }
}
