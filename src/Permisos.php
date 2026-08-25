<?php

namespace Muni\Arcop;

/**
 * Los tres permisos del ciclo ARCOP.
 *
 * Son tres y no uno porque el municipio que quiera separar la recepción de la
 * resolución tiene que poder hacerlo: quien atiende el mesón no es
 * necesariamente quien resuelve, y esa separación es una garantía para el
 * vecino, no una comodidad administrativa.
 *
 * El paquete los define DENEGANDO. Un sistema que instale esto y no los mapee
 * no abre ninguna pantalla, que es lo correcto: acá se ven y se resuelven datos
 * personales de vecinos, y un permiso que se otorga solo por instalar un
 * paquete es un permiso que nadie decidió dar.
 */
final class Permisos
{
    public const VER = 'arcop.ver';

    public const RECIBIR = 'arcop.recibir';

    public const RESOLVER = 'arcop.resolver';

    /** @return array<int, string> */
    public static function todos(): array
    {
        return [self::VER, self::RECIBIR, self::RESOLVER];
    }
}
